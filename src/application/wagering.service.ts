import { randomUUID, createHash } from 'node:crypto';
import { Injectable, ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import { Money, type MoneyProps } from '../domain/money';
import { Wallet } from '../domain/wallet';
import { InsufficientFundsError } from '../domain/errors';
import { LedgerDirection } from '../domain/ledger-entry';
import { FailureCode, WagerTransactionKind, WagerTransactionStatus } from '../domain/transaction';
import { InboxMessageEntity, OutboxMessageEntity, WalletEntity, WalletLedgerEntryEntity, WagerTransactionEntity } from '../infrastructure/persistence/entities';
import { IntegrationEvent, WalletBalanceChanged, WagerTransactionPendingReference, WagerTransactionProcessed, WagerTransactionRejected } from '../domain/integration-events';

export interface CreateWalletInput { playerId: string; initialBalance: MoneyProps }
export interface SubmitWagerInput {
  providerId: string; externalTransactionId: string; playerId: string; walletId: string;
  roundId: string; gameId: string; kind: WagerTransactionKind; money: MoneyProps;
  referenceExternalTransactionId?: string;
}
export interface SubmitWagerResult { transactionId: string; status: WagerTransactionStatus; balance: MoneyProps; idempotentReplay: boolean }
export interface QueueWagerMessage { messageId: string; data: SubmitWagerInput & { idempotencyKey: string } }

@Injectable()
export class WageringService {
  public constructor(private readonly em: EntityManager) {}

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
            status: WagerTransactionStatus.Processed, observedBalanceAmount: initialBalance.toJSON().amount, processedAt: now, createdAt: now,
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
        // Persist first: the database's unique constraint is the definitive idempotency gate.
        const transaction = em.create(WagerTransactionEntity, {
          id: randomUUID(), providerId: input.providerId, externalTransactionId: input.externalTransactionId,
          idempotencyKey, payloadHash, walletId: input.walletId, playerId: input.playerId,
          roundId: input.roundId, gameId: input.gameId, kind: input.kind, amount: money.toJSON().amount,
          currency: money.currency, referenceExternalTransactionId: input.referenceExternalTransactionId,
          status: WagerTransactionStatus.Pending, createdAt: now,
        });
        em.persist(transaction);
        await em.flush();

        const walletEntity = await em.findOne(WalletEntity, { id: input.walletId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
        if (!walletEntity) throw new NotFoundException('Wallet not found.');
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
      const duplicate = await this.em.findOneOrFail(WagerTransactionEntity, { idempotencyKey });
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
      const existing = await this.em.findOneOrFail(WagerTransactionEntity, { idempotencyKey: message.data.idempotencyKey });
      return this.replay(existing, canonicalHash(message.data));
    }
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
    return { transactionId: transaction.id, status: transaction.status, balance: { amount: transaction.observedBalanceAmount ?? '0.00', currency: transaction.currency }, idempotentReplay: true };
  }
  private response(transaction: WagerTransactionEntity, wallet: WalletEntity, idempotentReplay: boolean): SubmitWagerResult {
    return { transactionId: transaction.id, status: transaction.status, balance: { amount: transaction.observedBalanceAmount ?? wallet.balance, currency: wallet.currency }, idempotentReplay };
  }
  private walletResponse(wallet: WalletEntity): { id: string; playerId: string; balance: MoneyProps; version: number } { return { id: wallet.id, playerId: wallet.playerId, balance: { amount: wallet.balance, currency: wallet.currency }, version: wallet.version }; }
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
