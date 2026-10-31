import { InvalidTransactionStateError } from './errors';
import { Money, type MoneyProps } from './money';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  InvalidReference = 'INVALID_REFERENCE',
  InvalidAmount = 'INVALID_AMOUNT',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  IdempotencyConflict = 'IDEMPOTENCY_CONFLICT',
  InfrastructureFailure = 'INFRASTRUCTURE_FAILURE',
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
  ) {}

  public static create(props: CreateWagerTransactionProps): WagerTransaction {
    const needsReference = props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (needsReference !== Boolean(props.referenceExternalTransactionId)) {
      throw new Error('A reference is required only for REFUND and ROLLBACK.');
    }
    if (props.kind === WagerTransactionKind.Opening) {
      throw new Error('OPENING transactions are internal and cannot be submitted.');
    }
    return new WagerTransaction(
      props.id, props.providerId, props.externalTransactionId, props.idempotencyKey,
      props.payloadHash, props.walletId, props.playerId, props.roundId, props.gameId,
      props.kind, Money.from(props.money), props.referenceExternalTransactionId,
      props.createdAt, WagerTransactionStatus.Pending,
    );
  }

  public static rehydrate(state: WagerTransaction): WagerTransaction { return state; }
  public get status(): WagerTransactionStatus { return this._status; }
  public get failureCode(): FailureCode | undefined { return this._failureCode; }
  public get processedAt(): Date | undefined { return this._processedAt; }
  public get referenceTransactionId(): string | undefined { return this._referenceTransactionId; }
  public isTerminal(): boolean { return [WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected, WagerTransactionStatus.Failed].includes(this._status); }
  public affectsBalance(): boolean { return this.kind !== WagerTransactionKind.Loss; }
  public requiresReference(): boolean { return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback; }
  public matchesPayload(payloadHash: string): boolean { return this.payloadHash === payloadHash; }

  public markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertNotTerminal();
    this._referenceTransactionId = referenceTransactionId;
    this._status = WagerTransactionStatus.Processed;
    this._processedAt = at;
  }
  public markPendingReference(): void { this.assertNotTerminal(); this._status = WagerTransactionStatus.PendingReference; }
  public reject(code: FailureCode): void { this.assertNotTerminal(); this._failureCode = code; this._status = WagerTransactionStatus.Rejected; }
  public fail(code: FailureCode): void { this.assertNotTerminal(); this._failureCode = code; this._status = WagerTransactionStatus.Failed; }
  private assertNotTerminal(): void { if (this.isTerminal()) throw new InvalidTransactionStateError(); }
}
