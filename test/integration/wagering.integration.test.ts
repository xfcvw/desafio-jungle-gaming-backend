import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MikroORM } from '@mikro-orm/postgresql';
import { AppModule } from '../../src/app.module';
import { OutboxPublisherService } from '../../src/infrastructure/messaging/outbox-publisher.service';
import { SqsTransport } from '../../src/infrastructure/messaging/sqs.transport';
import { WagerConsumerService } from '../../src/infrastructure/messaging/wager-consumer.service';
import { WageringService } from '../../src/application/wagering.service';
import { WagerTransactionKind } from '../../src/domain/transaction';

/**
 * Requer PostgreSQL e LocalStack reais iniciados por `docker compose up -d`.
 * Execute com: RUN_WORKERS=false bun run test:integration
 */
describe('integração do processador de apostas', () => {
  const apps: INestApplication[] = [];
  let orm: MikroORM;
  const baseUrls: string[] = [];
  let requestIndex = 0;

  beforeAll(async () => {
    process.env.RUN_WORKERS = 'false';
    process.env.SQS_WAIT_TIME_SECONDS = '0';
    process.env.SQS_VISIBILITY_TIMEOUT = '0';
    for (let index = 0; index < 3; index += 1) {
      const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
      const app = module.createNestApplication();
      app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
      await app.init();
      await app.listen(0, '127.0.0.1');
      const address = app.getHttpServer().address() as AddressInfo;
      apps.push(app);
      baseUrls.push(`http://127.0.0.1:${address.port}`);
    }
    orm = apps[0]!.get(MikroORM);
    await orm.migrator.up();
    const transport = apps[0]!.get(SqsTransport);
    await transport.configureWagerDlqForTest();
    await transport.purgeWagersForTest();
  }, 60_000);

  afterEach(async () => {
    await orm.em.getConnection().execute('truncate table outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets cascade');
  });

  afterAll(async () => { await Promise.all(apps.map((app) => app.close())); });

  test('deduplica cinquenta entregas idênticas sem duplicar o débito', async () => {
    const wallet = await createWallet('jogador-idempotente', '100.00');
    const body = wager(wallet.id, 'jogador-idempotente', 'bet-50-parallel', '25.00');
    const responses = await Promise.all(Array.from({ length: 50 }, () => post('/wagering/transactions', body, 'provider-a:bet-50-parallel')));
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(responses.filter((response) => response.body.idempotentReplay === false)).toHaveLength(1);
    expect((await get(`/wallets/${wallet.id}`)).body.balance.amount).toBe('75.00');
    const ledger = await get(`/wallets/${wallet.id}/ledger?limit=100`);
    expect(ledger.body.entries).toHaveLength(2); // OPENING + uma única BET
  }, 60_000);

  test('serializa duas apostas concorrentes que disputam o mesmo saldo', async () => {
    const wallet = await createWallet('jogador-concorrente', '100.00');
    const [first, second] = await Promise.all([
      post('/wagering/transactions', wager(wallet.id, 'jogador-concorrente', 'bet-race-a', '80.00'), 'provider-a:bet-race-a'),
      post('/wagering/transactions', wager(wallet.id, 'jogador-concorrente', 'bet-race-b', '80.00'), 'provider-a:bet-race-b'),
    ]);
    expect([first.body.status, second.body.status].sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect((await get(`/wallets/${wallet.id}`)).body.balance.amount).toBe('20.00');
    const ledger = await get(`/wallets/${wallet.id}/ledger?limit=100`);
    expect(ledger.body.entries.filter((entry: { direction: string }) => entry.direction === 'DEBIT')).toHaveLength(1);
  }, 60_000);

  test('processa wallets diferentes em paralelo sem serialização global', async () => {
    const [firstWallet, secondWallet] = await Promise.all([
      createWallet('jogador-paralelo-a', '100.00'),
      createWallet('jogador-paralelo-b', '100.00'),
    ]);
    const [first, second] = await Promise.all([
      post('/wagering/transactions', wager(firstWallet.id, 'jogador-paralelo-a', 'bet-paralela-a', '60.00'), 'provider-a:bet-paralela-a'),
      post('/wagering/transactions', wager(secondWallet.id, 'jogador-paralelo-b', 'bet-paralela-b', '70.00'), 'provider-a:bet-paralela-b'),
    ]);
    expect([first.body.status, second.body.status]).toEqual(['PROCESSED', 'PROCESSED']);
    expect((await get(`/wallets/${firstWallet.id}`)).body.balance.amount).toBe('40.00');
    expect((await get(`/wallets/${secondWallet.id}`)).body.balance.amount).toBe('30.00');
  }, 60_000);

  test('rejeita reutilização de idempotency key com payload divergente', async () => {
    const wallet = await createWallet('jogador-chave-conflitante', '100.00');
    const key = 'provider-a:chave-conflitante';
    const first = await post('/wagering/transactions', wager(wallet.id, 'jogador-chave-conflitante', 'bet-chave-1', '25.00'), key);
    const conflicting = await post('/wagering/transactions', wager(wallet.id, 'jogador-chave-conflitante', 'bet-chave-2', '30.00'), key);
    expect(first.body.status).toBe('PROCESSED');
    expect(conflicting.status).toBe(409);
    expect((await get(`/wallets/${wallet.id}`)).body.balance.amount).toBe('75.00');
  });

  test('rejeita moeda diferente da carteira sem criar lançamento no ledger', async () => {
    const wallet = await createWallet('jogador-moeda-divergente', '100.00');
    const response = await post('/wagering/transactions', {
      ...wager(wallet.id, 'jogador-moeda-divergente', 'bet-usd', '25.00'),
      money: { amount: '25.00', currency: 'USD' },
    }, 'provider-a:bet-usd');
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ status: 'REJECTED', balance: { amount: '100.00', currency: 'BRL' } });
    const ledger = await get(`/wallets/${wallet.id}/ledger?limit=100`);
    expect(ledger.body.entries).toHaveLength(1); // Apenas OPENING.
  });

  test('o banco bloqueia alteração e remoção de lançamentos do ledger', async () => {
    const wallet = await createWallet('jogador-ledger-imutavel', '100.00');
    const ledger = await get(`/wallets/${wallet.id}/ledger?limit=10`);
    const entryId = ledger.body.entries[0].id as string;
    await expect(orm.em.getConnection().execute('update wallet_ledger_entries set amount = 1.00 where id = ?', [entryId])).rejects.toThrow('Ledger entries are immutable');
    await expect(orm.em.getConnection().execute('delete from wallet_ledger_entries where id = ?', [entryId])).rejects.toThrow('Ledger entries are immutable');
  });

  test('reconcilia o saldo materializado com o ledger imutável', async () => {
    const wallet = await createWallet('jogador-reconciliacao', '100.00');
    await post('/wagering/transactions', wager(wallet.id, 'jogador-reconciliacao', 'bet-reconcile', '30.00'), 'provider-a:bet-reconcile');
    const result = await post(`/wallets/${wallet.id}/reconciliation`, undefined);
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ consistent: true, storedBalance: { amount: '70.00', currency: 'BRL' }, calculatedBalance: { amount: '70.00', currency: 'BRL' } });
  });

  test('aplica BET, WIN, LOSS, REFUND e ROLLBACK com os efeitos corretos', async () => {
    const wallet = await createWallet('jogador-reversoes', '100.00');
    const bet = await post('/wagering/transactions', wager(wallet.id, 'jogador-reversoes', 'bet-reversoes', '30.00'), 'provider-a:bet-reversoes');
    const win = await post('/wagering/transactions', wager(wallet.id, 'jogador-reversoes', 'win-reversoes', '30.00', WagerTransactionKind.Win), 'provider-a:win-reversoes');
    const loss = await post('/wagering/transactions', wager(wallet.id, 'jogador-reversoes', 'loss-reversoes', '10.00', WagerTransactionKind.Loss), 'provider-a:loss-reversoes');
    const refund = await post('/wagering/transactions', wager(wallet.id, 'jogador-reversoes', 'refund-reversoes', '30.00', WagerTransactionKind.Refund, 'bet-reversoes'), 'provider-a:refund-reversoes');
    const rollback = await post('/wagering/transactions', wager(wallet.id, 'jogador-reversoes', 'rollback-reversoes', '30.00', WagerTransactionKind.Rollback, 'win-reversoes'), 'provider-a:rollback-reversoes');
    expect([bet.body.status, win.body.status, loss.body.status, refund.body.status, rollback.body.status]).toEqual(['PROCESSED', 'PROCESSED', 'PROCESSED', 'PROCESSED', 'PROCESSED']);
    // 100 - BET 30 + WIN 30 + REFUND 30 - ROLLBACK do WIN 30 = 100.
    expect((await get(`/wallets/${wallet.id}`)).body.balance.amount).toBe('100.00');
    const ledger = await get(`/wallets/${wallet.id}/ledger?limit=100`);
    expect(ledger.body.entries).toHaveLength(5); // OPENING, BET, WIN, REFUND e ROLLBACK; LOSS não movimenta saldo.
  });

  test('persiste referência recebida fora de ordem e a aplica depois', async () => {
    const wallet = await createWallet('jogador-fora-de-ordem', '100.00');
    const pending = await post('/wagering/transactions', wager(wallet.id, 'jogador-fora-de-ordem', 'refund-antes', '20.00', WagerTransactionKind.Refund, 'bet-depois'), 'provider-a:refund-antes');
    expect(pending.body.status).toBe('PENDING_REFERENCE');
    const reference = await post('/wagering/transactions', wager(wallet.id, 'jogador-fora-de-ordem', 'bet-depois', '20.00'), 'provider-a:bet-depois');
    expect(reference.body.status).toBe('PROCESSED');
    const directLookup = await orm.em.getConnection().execute<Array<Record<string, unknown>>>(
      'select provider_id, external_transaction_id, status, wallet_id, player_id, round_id, game_id, amount, currency from wager_transactions where external_transaction_id = ?',
      ['bet-depois'],
    );
    console.info('diagnostico-before-worker', directLookup);
    expect(await apps[0]!.get(WageringService).reprocessPendingReferences()).toBe(1);
    const pendingAfterWorker = await orm.em.getConnection().execute<Array<Record<string, unknown>>>(
      'select status, reference_transaction_id, reference_attempts, next_reference_attempt_at, failure_code from wager_transactions where id = ?',
      [pending.body.transactionId],
    );
    console.info('diagnostico-after-worker', pendingAfterWorker);
    expect((await get(`/wagering/transactions/${pending.body.transactionId}`)).body.status).toBe('PROCESSED');
    expect((await get(`/wallets/${wallet.id}`)).body.balance.amount).toBe('100.00');
  });

  test('deduplica redelivery na Inbox usando uma fila SQS real', async () => {
    const wallet = await createWallet('jogador-inbox', '100.00');
    const transport = apps[0]!.get(SqsTransport);
    const consumer = apps[1]!.get(WagerConsumerService);
    const service = apps[2]!.get(WageringService);
    const externalTransactionId = `bet-inbox-${randomUUID()}`;
    const messageId = randomUUID();
    const data = { ...wager(wallet.id, 'jogador-inbox', externalTransactionId, '25.00'), idempotencyKey: `provider-a:${externalTransactionId}` };
    const envelope = { messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data };

    await transport.publishWagerRequest(envelope, wallet.id, randomUUID());
    expect(await consumer.consumeOnce()).toBeGreaterThanOrEqual(1);
    const replay = await service.submitFromQueue({ messageId, data });
    expect(replay.idempotentReplay).toBe(true);

    expect((await get(`/wallets/${wallet.id}`)).body.balance.amount).toBe('75.00');
    const [inbox] = await orm.em.getConnection().execute<Array<{ total: string }>>('select count(*)::text as total from inbox_messages');
    expect(inbox?.total).toBe('1');
    const ledger = await get(`/wallets/${wallet.id}/ledger?limit=100`);
    expect(ledger.body.entries.filter((entry: { direction: string }) => entry.direction === 'DEBIT')).toHaveLength(1);
  }, 60_000);

  test('mantém o efeito único quando há commit antes do ack e posterior redelivery', async () => {
    const wallet = await createWallet('jogador-commit-sem-ack', '100.00');
    const transport = apps[0]!.get(SqsTransport);
    const service = apps[0]!.get(WageringService);
    const consumer = apps[1]!.get(WagerConsumerService);
    const messageId = randomUUID();
    const externalTransactionId = `bet-commit-sem-ack-${randomUUID()}`;
    const data = { ...wager(wallet.id, 'jogador-commit-sem-ack', externalTransactionId, '25.00'), idempotencyKey: `provider-a:${externalTransactionId}` };
    const envelope = { messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data };

    // Simula o processo morrendo depois do commit e antes de confirmar a mensagem no SQS.
    expect((await service.submitFromQueue({ messageId, data })).idempotentReplay).toBe(false);
    await transport.publishWagerRequest(envelope, wallet.id, randomUUID());
    expect(await consumer.consumeOnce()).toBeGreaterThanOrEqual(1);
    expect((await get(`/wallets/${wallet.id}`)).body.balance.amount).toBe('75.00');
    const ledger = await get(`/wallets/${wallet.id}/ledger?limit=100`);
    expect(ledger.body.entries.filter((entry: { direction: string }) => entry.direction === 'DEBIT')).toHaveLength(1);
  }, 60_000);

  test('dois publishers concorrentes concluem a mesma Outbox sem perda', async () => {
    const wallet = await createWallet('jogador-outbox', '100.00');
    await post('/wagering/transactions', wager(wallet.id, 'jogador-outbox', 'bet-outbox-1', '10.00'), 'provider-a:bet-outbox-1');
    const first = apps[0]!.get(OutboxPublisherService);
    const second = apps[1]!.get(OutboxPublisherService);
    await Promise.all([first.publishDue(), second.publishDue()]);
    const [summary] = await orm.em.getConnection().execute<Array<{ pending: string }>>(
      'select count(*) filter (where published_at is null)::text as pending from outbox_messages',
    );
    expect(summary?.pending).toBe('0');
  }, 60_000);

  test('uma nova instância publica a Outbox que ficou pendente antes do reinício', async () => {
    const wallet = await createWallet('jogador-reinicio-outbox', '100.00');
    await post('/wagering/transactions', wager(wallet.id, 'jogador-reinicio-outbox', 'bet-reinicio-outbox', '10.00'), 'provider-a:bet-reinicio-outbox');
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const restarted = module.createNestApplication();
    await restarted.init();
    try {
      await restarted.get(OutboxPublisherService).publishDue();
      const [summary] = await orm.em.getConnection().execute<Array<{ pending: string }>>(
        'select count(*) filter (where published_at is null)::text as pending from outbox_messages',
      );
      expect(summary?.pending).toBe('0');
    } finally {
      await restarted.close();
    }
  }, 60_000);

  test('encaminha falha transitória repetida para a DLQ', async () => {
    const transport = apps[0]!.get(SqsTransport);
    const consumer = apps[1]!.get(WagerConsumerService);
    const messageId = randomUUID();
    const nonexistentWalletId = randomUUID();
    const externalTransactionId = `bet-dlq-${randomUUID()}`;
    const data = { ...wager(nonexistentWalletId, 'jogador-inexistente', externalTransactionId, '10.00'), idempotencyKey: `provider-a:${externalTransactionId}` };
    const envelope = { messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data };
    await transport.publishWagerRequest(envelope, nonexistentWalletId, randomUUID());
    process.env.SQS_VISIBILITY_TIMEOUT = '1';
    for (let attempt = 0; attempt < 7; attempt += 1) {
      await consumer.consumeOnce();
      // LocalStack pode aplicar aproximadamente dois segundos antes de redeliver uma FIFO.
      await new Promise((resolve) => setTimeout(resolve, 2_100));
    }
    const deadLetters = await transport.receiveWagerDeadLetters();
    expect(deadLetters.some((message) => message.Body?.includes(messageId))).toBe(true);
  }, 60_000);

  async function createWallet(playerId: string, amount: string): Promise<{ id: string }> {
    const response = await post('/wallets', { playerId, initialBalance: { amount, currency: 'BRL' } });
    expect(response.status).toBe(201);
    return response.body;
  }
  function wager(walletId: string, playerId: string, externalTransactionId: string, amount: string, kind = WagerTransactionKind.Bet, referenceExternalTransactionId?: string) {
    return { providerId: 'provider-a', externalTransactionId, playerId, walletId, roundId: 'round-1', gameId: 'game-1', kind, money: { amount, currency: 'BRL' }, ...(referenceExternalTransactionId ? { referenceExternalTransactionId } : {}) };
  }
  function nextBaseUrl(): string { const value = baseUrls[requestIndex % baseUrls.length]; requestIndex += 1; return value!; }
  async function get(path: string) { const response = await fetch(`${nextBaseUrl()}${path}`); return { status: response.status, body: await response.json() as any }; }
  async function post(path: string, body: unknown, idempotencyKey?: string) {
    const response = await fetch(`${nextBaseUrl()}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  }
});
