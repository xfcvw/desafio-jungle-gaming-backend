import { randomUUID, createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { Injectable, ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import { Money, type MoneyProps } from '../domain/money';
import { Wallet } from '../domain/wallet';
import { InsufficientFundsError } from '../domain/errors';
import { LedgerDirection } from '../domain/ledger-entry';
import { FailureCode, WagerTransactionKind, WagerTransactionStatus } from '../domain/transaction';
import { InboxMessageEntity, OutboxMessageEntity, WalletEntity, WalletLedgerEntryEntity, WagerTransactionEntity } from '../infrastructure/persistence/entities';
import { IntegrationEvent, WalletBalanceChanged, WagerTransactionPendingReference, WagerTransactionProcessed, WagerTransactionRejected } from '../domain/integration-events';
import { MetricsService } from '../infrastructure/observability/metrics.service';

export interface CreateWalletInput { playerId: string; initialBalance: MoneyProps }
export interface SubmitWagerInput {
  providerId: string; externalTransactionId: string; playerId: string; walletId: string;
  roundId: string; gameId: string; kind: WagerTransactionKind; money: MoneyProps;
  referenceExternalTransactionId?: string;
}
export interface SubmitWagerResult { transactionId: string; status: WagerTransactionStatus; balance: MoneyProps; idempotentReplay: boolean }
export interface QueueWagerMessage { messageId: string; data: SubmitWagerInput & { idempotencyKey: string } }
export interface LedgerPage {
  entries: Array<{ id: string; transactionId: string; direction: LedgerDirection; money: MoneyProps; balanceBefore: MoneyProps; balanceAfter: MoneyProps; createdAt: string }>;
  nextCursor?: string;
}
export interface ReconciliationResult {
  walletId: string; storedBalance: MoneyProps; calculatedBalance: MoneyProps;
  difference: string; consistent: boolean; checkedEntries: number;
}

@Injectable()
export class WageringService {
  public constructor(private readonly em: EntityManager, private readonly metrics: MetricsService) {}

  public async createWallet(input: CreateWalletInput): Promise<{ id: string; playerId: string; balance: MoneyProps; version: number }> {
    const initialBalance = Money.from(input.initialBalance);
    try {
      return await this.em.transactional(async (em) => {
        const now = new Date();
        const wallet = em.create(WalletEntity, {
          id: randomUUID(), playerId: input.playerId, currency: initialBalance.currency,
          balance: initialBalance.toJSON().amount, version: 1, createdAt: now, updatedAt: now,
        }, { persist: false });
        em.persist(wallet);
        // Entities use scalar foreign keys rather than ORM relations, so flush the
        // parent before the opening transaction and its ledger entry reference it.
        await em.flush();
        if (initialBalance.isPositive()) {
          const opening = em.create(WagerTransactionEntity, {
            id: randomUUID(), providerId: 'internal', externalTransactionId: `opening:${wallet.id}`,
            idempotencyKey: `internal:opening:${wallet.id}`, payloadHash: '0'.repeat(64),
            walletId: wallet.id, playerId: input.playerId, roundId: 'opening', gameId: 'opening',
            kind: WagerTransactionKind.Opening, amount: initialBalance.toJSON().amount, currency: initialBalance.currency,
            status: WagerTransactionStatus.Processed, observedBalanceAmount: initialBalance.toJSON().amount, referenceAttempts: 0, processedAt: now, createdAt: now,
          }, { persist: false });
          const entry = em.create(WalletLedgerEntryEntity, {
            id: randomUUID(), walletId: wallet.id, transactionId: opening.id, direction: LedgerDirection.Credit,
            amount: initialBalance.toJSON().amount, currency: initialBalance.currency, balanceBefore: '0.00', balanceAfter: initialBalance.toJSON().amount, createdAt: now,
          }, { persist: false });
          em.persist(opening);
          await em.flush();
          em.persist(entry);
        }
        await em.flush();
        return { id: wallet.id, playerId: wallet.playerId, balance: initialBalance.toJSON(), version: wallet.version };
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) throw new ConflictException('A wallet already exists for this player and currency.');
      throw error;
    }
  }

  public async getWallet(id: string): Promise<{ id: string; playerId: string; balance: MoneyProps; version: number }> {
    const wallet = await this.em.findOne(WalletEntity, { id });
    if (!wallet) throw new NotFoundException('Wallet not found.');
    return this.walletResponse(wallet);
  }

  public async getLedger(walletId: string, cursor: string | undefined, requestedLimit: number | undefined): Promise<LedgerPage> {
    const wallet = await this.em.findOne(WalletEntity, { id: walletId });
    if (!wallet) throw new NotFoundException('Wallet not found.');
    const limit = Math.min(Math.max(requestedLimit ?? 50, 1), 100);
    const position = decodeCursor(cursor);
    const rows = await this.em.getConnection().execute<Array<{
      id: string; transaction_id: string; direction: LedgerDirection; amount: string; currency: string;
      balance_before: string; balance_after: string; created_at: Date;
    }>>(
      `select id, transaction_id, direction, amount::text, currency, balance_before::text, balance_after::text, created_at
       from wallet_ledger_entries
       where wallet_id = ? and (? is null or (created_at, id) > (?::timestamptz, ?::uuid))
       order by created_at asc, id asc limit ?`,
      [walletId, position?.createdAt ?? null, position?.createdAt ?? null, position?.id ?? null, limit + 1],
    );
    const hasNext = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      entries: page.map((row) => ({
        id: row.id, transactionId: row.transaction_id, direction: row.direction,
        money: { amount: row.amount, currency: row.currency },
        balanceBefore: { amount: row.balance_before, currency: row.currency },
        balanceAfter: { amount: row.balance_after, currency: row.currency },
        createdAt: new Date(row.created_at).toISOString(),
      })),
      nextCursor: hasNext && last ? encodeCursor({ createdAt: new Date(last.created_at).toISOString(), id: last.id }) : undefined,
    };
  }

  public async getTransaction(transactionId: string): Promise<Record<string, unknown>> {
    const transaction = await this.em.findOne(WagerTransactionEntity, { id: transactionId });
    if (!transaction) throw new NotFoundException('Transaction not found.');
    return this.transactionResponse(transaction);
  }

  public async getTransactionByProvider(providerId: string, externalTransactionId: string): Promise<Record<string, unknown>> {
    const transaction = await this.em.findOne(WagerTransactionEntity, { providerId, externalTransactionId });
    if (!transaction) throw new NotFoundException('Transaction not found.');
    return this.transactionResponse(transaction);
  }

  public async reconcile(walletId: string): Promise<ReconciliationResult> {
    const wallet = await this.em.findOne(WalletEntity, { id: walletId });
    if (!wallet) throw new NotFoundException('Wallet not found.');
    const [summary] = await this.em.getConnection().execute<Array<{ calculated_balance: string; checked_entries: string }>>(
      `select coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0)::text as calculated_balance,
              count(*)::text as checked_entries from wallet_ledger_entries where wallet_id = ?`, [walletId],
    );
    const calculated = summary?.calculated_balance ?? '0.00';
    const difference = new Decimal(wallet.balance).minus(calculated).toFixed(2);
    return {
      walletId, storedBalance: { amount: wallet.balance, currency: wallet.currency },
      calculatedBalance: { amount: calculated, currency: wallet.currency }, difference,
      consistent: difference === '0.00', checkedEntries: Number(summary?.checked_entries ?? '0'),
    };
  }

  public async submit(input: SubmitWagerInput, idempotencyKey: string, transactionEm?: EntityManager): Promise<SubmitWagerResult> {
    if (!idempotencyKey) throw new UnprocessableEntityException('Idempotency-Key header is required.');
    if (input.kind === WagerTransactionKind.Opening) throw new UnprocessableEntityException('OPENING is an internal transaction.');
    const money = Money.from(input.money);
    const payloadHash = canonicalHash(input);
    const manager = transactionEm ?? this.em;
    const existing = await manager.findOne(WagerTransactionEntity, { idempotencyKey });
    if (existing) return this.replay(existing, payloadHash);

    const execute = async (em: EntityManager): Promise<SubmitWagerResult> => {
        const now = new Date();
        // O lock precisa vir antes do INSERT com FK para a wallet. Inserir primeiro
        // mantém um lock compartilhado pela FK; duas transações concorrentes podem
        // então formar um ciclo ao tentar FOR UPDATE na mesma carteira.
        const walletEntity = await em.findOne(WalletEntity, { id: input.walletId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
        if (!walletEntity) throw new NotFoundException('Wallet not found.');

        // A constraint única continua sendo o portão definitivo da idempotência.
        const transaction = em.create(WagerTransactionEntity, {
          id: randomUUID(), providerId: input.providerId, externalTransactionId: input.externalTransactionId,
          idempotencyKey, payloadHash, walletId: input.walletId, playerId: input.playerId,
          roundId: input.roundId, gameId: input.gameId, kind: input.kind, amount: money.toJSON().amount,
          currency: money.currency, referenceExternalTransactionId: input.referenceExternalTransactionId,
          status: WagerTransactionStatus.Pending, referenceAttempts: 0, createdAt: now,
        });
        em.persist(transaction);
        await em.flush();

        if (walletEntity.playerId !== input.playerId || walletEntity.currency !== money.currency) {
          transaction.status = WagerTransactionStatus.Rejected;
          transaction.failureCode = FailureCode.CurrencyMismatch;
          transaction.observedBalanceAmount = walletEntity.balance;
          transaction.processedAt = now;
          this.enqueue(em, WagerTransactionRejected.from(randomUUID(), this.eventData(transaction), now));
          await em.flush();
          return this.response(transaction, walletEntity, false);
        }

        const wallet = Wallet.rehydrate({
          id: walletEntity.id, playerId: walletEntity.playerId, currency: walletEntity.currency,
          balance: { amount: walletEntity.balance, currency: walletEntity.currency }, version: walletEntity.version,
          createdAt: walletEntity.createdAt, updatedAt: walletEntity.updatedAt,
        });

        const reference = await this.resolveReference(em, transaction);
        if (transaction.status === WagerTransactionStatus.PendingReference) {
          transaction.observedBalanceAmount = walletEntity.balance;
          this.enqueue(em, WagerTransactionPendingReference.from(randomUUID(), this.eventData(transaction), now));
          await em.flush();
          return this.response(transaction, walletEntity, false);
        }
        if (transaction.status === WagerTransactionStatus.Rejected) {
          transaction.observedBalanceAmount = walletEntity.balance;
          this.enqueue(em, WagerTransactionRejected.from(randomUUID(), this.eventData(transaction), now));
          await em.flush();
          return this.response(transaction, walletEntity, false);
        }

        try {
          const direction = this.directionFor(transaction, reference);
          if (direction) {
            const entry = direction === LedgerDirection.Debit
              ? wallet.debit({ entryId: randomUUID(), transactionId: transaction.id, money, now })
              : wallet.credit({ entryId: randomUUID(), transactionId: transaction.id, money, now });
            walletEntity.balance = wallet.balance.toJSON().amount;
            walletEntity.version = wallet.version;
            walletEntity.updatedAt = now;
            em.persist(em.create(WalletLedgerEntryEntity, {
              id: entry.id, walletId: entry.walletId, transactionId: entry.transactionId, direction: entry.direction,
              amount: entry.money.toJSON().amount, currency: entry.money.currency,
              balanceBefore: entry.balanceBefore.toJSON().amount, balanceAfter: entry.balanceAfter.toJSON().amount, createdAt: entry.createdAt,
            }));
            this.enqueue(em, WalletBalanceChanged.from(randomUUID(), { ...this.eventData(transaction), direction, money: entry.money.toJSON(), balanceBefore: entry.balanceBefore.toJSON(), balanceAfter: entry.balanceAfter.toJSON(), walletVersion: wallet.version }, now));
          }
          transaction.status = WagerTransactionStatus.Processed;
          transaction.referenceTransactionId = reference?.id;
          transaction.observedBalanceAmount = walletEntity.balance;
          transaction.processedAt = now;
          this.enqueue(em, WagerTransactionProcessed.from(randomUUID(), this.eventData(transaction), now));
        } catch (error) {
          if (!(error instanceof InsufficientFundsError)) throw error;
          transaction.status = WagerTransactionStatus.Rejected;
          transaction.failureCode = this.isReversal(transaction.kind) ? FailureCode.ReversalWouldOverdraw : FailureCode.InsufficientFunds;
          transaction.observedBalanceAmount = walletEntity.balance;
          transaction.processedAt = now;
          this.enqueue(em, WagerTransactionRejected.from(randomUUID(), this.eventData(transaction), now));
        }
        await em.flush();
        return this.response(transaction, walletEntity, false);
    };
    try {
      return await (transactionEm ? execute(transactionEm) : this.em.transactional(execute));
    } catch (error) {
      if (!this.isUniqueViolation(error)) throw error;
      const duplicate = await this.em.fork().findOneOrFail(WagerTransactionEntity, { idempotencyKey });
      return this.replay(duplicate, payloadHash);
    }
  }

  /**
   * Keeps Inbox, financial mutation, ledger and Outbox in one SQL transaction.
   * A committed duplicate is safe to acknowledge because its original wager is replayed.
   */
  public async submitFromQueue(message: QueueWagerMessage): Promise<SubmitWagerResult> {
    const payloadHash = canonicalHash(message.data);
    try {
      return await this.em.transactional(async (em) => {
        const inbox = em.create(InboxMessageEntity, {
          id: randomUUID(), consumerName: 'wager-transactions-consumer', messageId: message.messageId,
          payloadHash, receivedAt: new Date(),
        });
        em.persist(inbox);
        await em.flush();
        const { idempotencyKey, ...input } = message.data;
        const result = await this.submit(input, idempotencyKey, em);
        inbox.processedAt = new Date();
        await em.flush();
        return result;
      });
    } catch (error) {
      if (!this.isUniqueViolation(error)) throw error;
      const existing = await this.em.fork().findOneOrFail(WagerTransactionEntity, { idempotencyKey: message.data.idempotencyKey });
      return this.replay(existing, canonicalHash(message.data));
    }
  }

  /** Reprocessa referências entregues antes da transação original, sem criar novo débito/crédito. */
  public async reprocessPendingReferences(limit = 50): Promise<number> {
    const pending = await this.em.find(WagerTransactionEntity, {
      status: WagerTransactionStatus.PendingReference,
      $or: [{ nextReferenceAttemptAt: null }, { nextReferenceAttemptAt: { $lte: new Date() } }],
    }, { limit, orderBy: { createdAt: 'asc' } });
    let processed = 0;
    for (const candidate of pending) {
      const didProcess = await this.em.transactional(async (em) => {
        const transaction = await em.findOne(WagerTransactionEntity, { id: candidate.id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
        if (!transaction || transaction.status !== WagerTransactionStatus.PendingReference) return false;
        const walletEntity = await em.findOne(WalletEntity, { id: transaction.walletId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
        if (!walletEntity) {
          transaction.status = WagerTransactionStatus.Failed;
          transaction.failureCode = FailureCode.InfrastructureFailure;
          transaction.processedAt = new Date();
          this.enqueue(em, WagerTransactionRejected.from(randomUUID(), this.eventData(transaction), transaction.processedAt));
          await em.flush();
          return true;
        }
        const now = new Date();
        transaction.referenceAttempts += 1;
        const reference = await this.resolveReference(em, transaction);
        if (transaction.status === WagerTransactionStatus.PendingReference) {
          if (transaction.referenceAttempts >= 10) {
            transaction.status = WagerTransactionStatus.Rejected;
            transaction.failureCode = FailureCode.ReferenceNotFound;
            transaction.processedAt = now;
            transaction.observedBalanceAmount = walletEntity.balance;
            this.enqueue(em, WagerTransactionRejected.from(randomUUID(), this.eventData(transaction), now));
          } else {
            transaction.nextReferenceAttemptAt = new Date(now.getTime() + Math.min(300, 2 ** transaction.referenceAttempts) * 1_000);
          }
          await em.flush();
          return true;
        }
        if (transaction.status === WagerTransactionStatus.Rejected) {
          transaction.observedBalanceAmount = walletEntity.balance;
          transaction.processedAt = now;
          this.enqueue(em, WagerTransactionRejected.from(randomUUID(), this.eventData(transaction), now));
          await em.flush();
          return true;
        }
        const wallet = Wallet.rehydrate({
          id: walletEntity.id, playerId: walletEntity.playerId, currency: walletEntity.currency,
          balance: { amount: walletEntity.balance, currency: walletEntity.currency }, version: walletEntity.version,
          createdAt: walletEntity.createdAt, updatedAt: walletEntity.updatedAt,
        });
        const money = Money.from({ amount: transaction.amount, currency: transaction.currency });
        try {
          const direction = this.directionFor(transaction, reference);
          if (direction) {
            const entry = direction === LedgerDirection.Debit
              ? wallet.debit({ entryId: randomUUID(), transactionId: transaction.id, money, now })
              : wallet.credit({ entryId: randomUUID(), transactionId: transaction.id, money, now });
            walletEntity.balance = wallet.balance.toJSON().amount;
            walletEntity.version = wallet.version;
            walletEntity.updatedAt = now;
            em.persist(em.create(WalletLedgerEntryEntity, {
              id: entry.id, walletId: entry.walletId, transactionId: entry.transactionId, direction: entry.direction,
              amount: entry.money.toJSON().amount, currency: entry.money.currency,
              balanceBefore: entry.balanceBefore.toJSON().amount, balanceAfter: entry.balanceAfter.toJSON().amount, createdAt: entry.createdAt,
            }));
            this.enqueue(em, WalletBalanceChanged.from(randomUUID(), { ...this.eventData(transaction), direction, money: entry.money.toJSON(), balanceBefore: entry.balanceBefore.toJSON(), balanceAfter: entry.balanceAfter.toJSON(), walletVersion: wallet.version }, now));
          }
          transaction.status = WagerTransactionStatus.Processed;
          transaction.referenceTransactionId = reference?.id;
          transaction.observedBalanceAmount = walletEntity.balance;
          transaction.processedAt = now;
          transaction.nextReferenceAttemptAt = undefined;
          this.enqueue(em, WagerTransactionProcessed.from(randomUUID(), this.eventData(transaction), now));
        } catch (error) {
          if (!(error instanceof InsufficientFundsError)) throw error;
          transaction.status = WagerTransactionStatus.Rejected;
          transaction.failureCode = FailureCode.ReversalWouldOverdraw;
          transaction.observedBalanceAmount = walletEntity.balance;
          transaction.processedAt = now;
          this.enqueue(em, WagerTransactionRejected.from(randomUUID(), this.eventData(transaction), now));
        }
        await em.flush();
        return true;
      });
      if (didProcess) processed += 1;
    }
    return processed;
  }

  private async resolveReference(em: EntityManager, transaction: WagerTransactionEntity): Promise<WagerTransactionEntity | undefined> {
    if (!this.isReversal(transaction.kind)) return undefined;
    if (!transaction.referenceExternalTransactionId) throw new UnprocessableEntityException('A reference transaction is required.');
    const ref = await em.findOne(WagerTransactionEntity, { providerId: transaction.providerId, externalTransactionId: transaction.referenceExternalTransactionId });
    if (!ref) { transaction.status = WagerTransactionStatus.PendingReference; return undefined; }
    const validKind = transaction.kind === WagerTransactionKind.Refund
      ? ref.kind === WagerTransactionKind.Bet
      : [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund].includes(ref.kind);
    const validContext = ref.status === WagerTransactionStatus.Processed && ref.walletId === transaction.walletId && ref.playerId === transaction.playerId && ref.roundId === transaction.roundId && ref.currency === transaction.currency && ref.amount === transaction.amount;
    const alreadyReversed = await em.findOne(WagerTransactionEntity, { referenceTransactionId: ref.id, kind: transaction.kind, status: WagerTransactionStatus.Processed });
    if (!validKind || !validContext || alreadyReversed) {
      transaction.status = WagerTransactionStatus.Rejected;
      transaction.failureCode = alreadyReversed ? FailureCode.InvalidReference : FailureCode.InvalidReference;
      return undefined;
    }
    return ref;
  }

  private directionFor(transaction: WagerTransactionEntity, reference?: WagerTransactionEntity): LedgerDirection | undefined {
    switch (transaction.kind) {
      case WagerTransactionKind.Bet: return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund: return LedgerDirection.Credit;
      case WagerTransactionKind.Loss: return undefined;
      case WagerTransactionKind.Rollback:
        if (!reference) throw new Error('Rollback reference was not resolved.');
        return reference.kind === WagerTransactionKind.Bet ? LedgerDirection.Credit : LedgerDirection.Debit;
      default: throw new Error(`Unsupported transaction kind: ${transaction.kind}`);
    }
  }

  private enqueue(em: EntityManager, event: IntegrationEvent<unknown>): void {
    em.persist(em.create(OutboxMessageEntity, {
      id: randomUUID(), aggregateId: event.aggregateId, eventType: event.eventType, occurredAt: event.occurredAt, attempts: 0, payload: event.toJSON(),
    }));
  }

  private eventData(transaction: WagerTransactionEntity): { transactionId: string; walletId: string; status: WagerTransactionStatus; failureCode?: string } {
    return { transactionId: transaction.id, walletId: transaction.walletId, status: transaction.status, failureCode: transaction.failureCode };
  }

  private replay(transaction: WagerTransactionEntity, payloadHash: string): SubmitWagerResult {
    if (transaction.payloadHash !== payloadHash) throw new ConflictException('Idempotency key is already associated with a different payload.');
    this.metrics.increment('wager_idempotency_replays_total', { providerId: transaction.providerId });
    return { transactionId: transaction.id, status: transaction.status, balance: { amount: transaction.observedBalanceAmount ?? '0.00', currency: transaction.currency }, idempotentReplay: true };
  }
  private response(transaction: WagerTransactionEntity, wallet: WalletEntity, idempotentReplay: boolean): SubmitWagerResult {
    this.metrics.increment('wager_transactions_total', { status: transaction.status, providerId: transaction.providerId });
    return { transactionId: transaction.id, status: transaction.status, balance: { amount: transaction.observedBalanceAmount ?? wallet.balance, currency: wallet.currency }, idempotentReplay };
  }
  private walletResponse(wallet: WalletEntity): { id: string; playerId: string; balance: MoneyProps; version: number } { return { id: wallet.id, playerId: wallet.playerId, balance: { amount: wallet.balance, currency: wallet.currency }, version: wallet.version }; }
  private transactionResponse(transaction: WagerTransactionEntity): Record<string, unknown> {
    return {
      transactionId: transaction.id, providerId: transaction.providerId, externalTransactionId: transaction.externalTransactionId,
      walletId: transaction.walletId, playerId: transaction.playerId, roundId: transaction.roundId, gameId: transaction.gameId,
      kind: transaction.kind, status: transaction.status, money: { amount: transaction.amount, currency: transaction.currency },
      referenceExternalTransactionId: transaction.referenceExternalTransactionId, referenceTransactionId: transaction.referenceTransactionId,
      failureCode: transaction.failureCode, balance: { amount: transaction.observedBalanceAmount ?? '0.00', currency: transaction.currency },
      createdAt: transaction.createdAt.toISOString(), processedAt: transaction.processedAt?.toISOString(),
    };
  }
  private isReversal(kind: WagerTransactionKind): boolean { return kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback; }
  private isUniqueViolation(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === '23505'; }
}

function canonicalHash(value: unknown): string {
  const canonicalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonicalize);
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonicalize(child)]));
    return input;
  };
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function encodeCursor(value: { createdAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor(cursor: string | undefined): { createdAt: string; id: string } | undefined {
  if (!cursor) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object' || !('createdAt' in value) || !('id' in value)
      || typeof value.createdAt !== 'string' || typeof value.id !== 'string' || Number.isNaN(Date.parse(value.createdAt))) throw new Error();
    return { createdAt: value.createdAt, id: value.id };
  } catch {
    throw new UnprocessableEntityException('Cursor is invalid.');
  }
}
