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
    await apps[0]!.get(SqsTransport).purgeWagersForTest();
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

  test('reconcilia o saldo materializado com o ledger imutável', async () => {
    const wallet = await createWallet('jogador-reconciliacao', '100.00');
    await post('/wagering/transactions', wager(wallet.id, 'jogador-reconciliacao', 'bet-reconcile', '30.00'), 'provider-a:bet-reconcile');
    const result = await post(`/wallets/${wallet.id}/reconciliation`, undefined);
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ consistent: true, storedBalance: { amount: '70.00', currency: 'BRL' }, calculatedBalance: { amount: '70.00', currency: 'BRL' } });
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

  test('encaminha falha transitória repetida para a DLQ', async () => {
    const transport = apps[0]!.get(SqsTransport);
    const consumer = apps[1]!.get(WagerConsumerService);
    const messageId = randomUUID();
    const nonexistentWalletId = randomUUID();
    const externalTransactionId = `bet-dlq-${randomUUID()}`;
    const data = { ...wager(nonexistentWalletId, 'jogador-inexistente', externalTransactionId, '10.00'), idempotencyKey: `provider-a:${externalTransactionId}` };
    const envelope = { messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data };
    await transport.publishWagerRequest(envelope, nonexistentWalletId, randomUUID());
    for (let attempt = 0; attempt < 8; attempt += 1) await consumer.consumeOnce({ releaseTransientFailures: true });
    const deadLetters = await transport.receiveWagerDeadLetters();
    expect(deadLetters.some((message) => message.Body?.includes(messageId))).toBe(true);
  }, 60_000);

  async function createWallet(playerId: string, amount: string): Promise<{ id: string }> {
    const response = await post('/wallets', { playerId, initialBalance: { amount, currency: 'BRL' } });
    expect(response.status).toBe(201);
    return response.body;
  }
  function wager(walletId: string, playerId: string, externalTransactionId: string, amount: string) {
    return { providerId: 'provider-a', externalTransactionId, playerId, walletId, roundId: 'round-1', gameId: 'game-1', kind: WagerTransactionKind.Bet, money: { amount, currency: 'BRL' } };
  }
  function nextBaseUrl(): string { const value = baseUrls[requestIndex % baseUrls.length]; requestIndex += 1; return value!; }
  async function get(path: string) { const response = await fetch(`${nextBaseUrl()}${path}`); return { status: response.status, body: await response.json() as any }; }
  async function post(path: string, body: unknown, idempotencyKey?: string) {
    const response = await fetch(`${nextBaseUrl()}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  }
});
