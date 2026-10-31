import type { LedgerDirection } from './ledger-entry';
import type { MoneyProps } from './money';
import type { WagerTransactionStatus } from './transaction';

interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  occurredAt: Date;
  data: T;
}

export abstract class IntegrationEvent<T> {
  public abstract readonly eventType: string;
  public abstract readonly version: number;
  public readonly eventId: string;
  public readonly aggregateId: string;
  public readonly correlationId: string;
  public readonly occurredAt: Date;
  public readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.occurredAt = props.occurredAt;
    this.data = Object.freeze(props.data);
  }

  public toJSON(): Record<string, unknown> {
    return { eventId: this.eventId, eventType: this.eventType, aggregateId: this.aggregateId, correlationId: this.correlationId, occurredAt: this.occurredAt.toISOString(), version: this.version, data: this.data };
  }
}

export interface WagerEventData { transactionId: string; walletId: string; status: WagerTransactionStatus; failureCode?: string }
type WagerSnapshot = WagerEventData;

abstract class WagerEvent extends IntegrationEvent<WagerEventData> {
  protected constructor(eventId: string, transaction: WagerSnapshot, occurredAt: Date) {
    super({ eventId, aggregateId: transaction.walletId, correlationId: transaction.transactionId, occurredAt, data: transaction });
  }
}

export class WagerTransactionProcessed extends WagerEvent {
  public readonly eventType = 'WagerTransactionProcessed';
  public readonly version = 1;
  public static from(eventId: string, transaction: WagerSnapshot, occurredAt: Date): WagerTransactionProcessed { return new WagerTransactionProcessed(eventId, transaction, occurredAt); }
}

export class WagerTransactionRejected extends WagerEvent {
  public readonly eventType = 'WagerTransactionRejected';
  public readonly version = 1;
  public static from(eventId: string, transaction: WagerSnapshot, occurredAt: Date): WagerTransactionRejected { return new WagerTransactionRejected(eventId, transaction, occurredAt); }
}

export class WagerTransactionPendingReference extends WagerEvent {
  public readonly eventType = 'WagerTransactionPendingReference';
  public readonly version = 1;
  public static from(eventId: string, transaction: WagerSnapshot, occurredAt: Date): WagerTransactionPendingReference { return new WagerTransactionPendingReference(eventId, transaction, occurredAt); }
}

export interface WalletBalanceChangedData extends WagerEventData {
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  public readonly eventType = 'WalletBalanceChanged';
  public readonly version = 1;
  public static from(eventId: string, data: WalletBalanceChangedData, occurredAt: Date): WalletBalanceChanged {
    return new WalletBalanceChanged({ eventId, aggregateId: data.walletId, correlationId: data.transactionId, occurredAt, data });
  }
}
