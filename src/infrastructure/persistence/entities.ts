import { Entity, Enum, Index, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';
import { LedgerDirection } from '../../domain/ledger-entry';
import { WagerTransactionKind, WagerTransactionStatus, FailureCode } from '../../domain/transaction';

@Entity({ tableName: 'wallets' })
@Unique({ name: 'wallet_player_currency_unique', properties: ['playerId', 'currency'] })
export class WalletEntity {
  @PrimaryKey({ type: 'uuid' }) id!: string;
  @Property({ type: 'string', fieldName: 'player_id' }) playerId!: string;
  @Property({ type: 'string', length: 3 }) currency!: string;
  @Property({ type: 'decimal', precision: 20, scale: 2 }) balance!: string;
  @Property({ type: 'integer' }) version = 1;
  @Property({ type: 'datetime', fieldName: 'created_at' }) createdAt = new Date();
  @Property({ type: 'datetime', fieldName: 'updated_at', onUpdate: () => new Date() }) updatedAt = new Date();
}

@Entity({ tableName: 'wager_transactions' })
@Unique({ name: 'wager_idempotency_key_unique', properties: ['idempotencyKey'] })
@Unique({ name: 'wager_provider_external_unique', properties: ['providerId', 'externalTransactionId'] })
@Index({ name: 'wager_reference_lookup_idx', properties: ['providerId', 'externalTransactionId'] })
export class WagerTransactionEntity {
  @PrimaryKey({ type: 'uuid' }) id!: string;
  @Property({ type: 'string', fieldName: 'provider_id' }) providerId!: string;
  @Property({ type: 'string', fieldName: 'external_transaction_id' }) externalTransactionId!: string;
  @Property({ type: 'string', fieldName: 'idempotency_key' }) idempotencyKey!: string;
  @Property({ type: 'string', fieldName: 'payload_hash', length: 64 }) payloadHash!: string;
  @Property({ fieldName: 'wallet_id', type: 'uuid' }) walletId!: string;
  @Property({ type: 'string', fieldName: 'player_id' }) playerId!: string;
  @Property({ type: 'string', fieldName: 'round_id' }) roundId!: string;
  @Property({ type: 'string', fieldName: 'game_id' }) gameId!: string;
  @Enum({ items: () => WagerTransactionKind }) kind!: WagerTransactionKind;
  @Property({ type: 'decimal', precision: 20, scale: 2 }) amount!: string;
  @Property({ type: 'string', length: 3 }) currency!: string;
  @Property({ type: 'string', fieldName: 'reference_external_transaction_id', nullable: true }) referenceExternalTransactionId?: string;
  @Enum({ items: () => WagerTransactionStatus }) status = WagerTransactionStatus.Pending;
  @Property({ fieldName: 'reference_transaction_id', type: 'uuid', nullable: true }) referenceTransactionId?: string;
  @Enum({ items: () => FailureCode, nullable: true, fieldName: 'failure_code' }) failureCode?: FailureCode;
  @Property({ fieldName: 'observed_balance_amount', type: 'decimal', precision: 20, scale: 2, nullable: true }) observedBalanceAmount?: string;
  @Property({ type: 'datetime', fieldName: 'processed_at', nullable: true }) processedAt?: Date;
  @Property({ type: 'datetime', fieldName: 'created_at' }) createdAt = new Date();
}

@Entity({ tableName: 'wallet_ledger_entries' })
@Unique({ name: 'ledger_transaction_unique', properties: ['transactionId'] })
@Index({ name: 'ledger_wallet_cursor_idx', properties: ['walletId', 'createdAt', 'id'] })
export class WalletLedgerEntryEntity {
  @PrimaryKey({ type: 'uuid' }) id!: string;
  @Property({ fieldName: 'wallet_id', type: 'uuid' }) walletId!: string;
  @Property({ fieldName: 'transaction_id', type: 'uuid' }) transactionId!: string;
  @Enum({ items: () => LedgerDirection }) direction!: LedgerDirection;
  @Property({ type: 'decimal', precision: 20, scale: 2 }) amount!: string;
  @Property({ type: 'string', length: 3 }) currency!: string;
  @Property({ fieldName: 'balance_before', type: 'decimal', precision: 20, scale: 2 }) balanceBefore!: string;
  @Property({ fieldName: 'balance_after', type: 'decimal', precision: 20, scale: 2 }) balanceAfter!: string;
  @Property({ type: 'datetime', fieldName: 'created_at' }) createdAt = new Date();
}

@Entity({ tableName: 'inbox_messages' })
@Unique({ name: 'inbox_consumer_message_unique', properties: ['consumerName', 'messageId'] })
export class InboxMessageEntity {
  @PrimaryKey({ type: 'uuid' }) id!: string;
  @Property({ type: 'string', fieldName: 'consumer_name' }) consumerName!: string;
  @Property({ type: 'string', fieldName: 'message_id' }) messageId!: string;
  @Property({ type: 'string', fieldName: 'payload_hash', length: 64 }) payloadHash!: string;
  @Property({ type: 'datetime', fieldName: 'received_at' }) receivedAt = new Date();
  @Property({ type: 'datetime', fieldName: 'processed_at', nullable: true }) processedAt?: Date;
}

@Entity({ tableName: 'outbox_messages' })
@Index({ name: 'outbox_pending_idx', properties: ['publishedAt', 'nextAttemptAt'] })
export class OutboxMessageEntity {
  @PrimaryKey({ type: 'uuid' }) id!: string;
  @Property({ fieldName: 'aggregate_id', type: 'uuid' }) aggregateId!: string;
  @Property({ type: 'string', fieldName: 'event_type' }) eventType!: string;
  @Property({ type: 'json' }) payload!: Record<string, unknown>;
  @Property({ type: 'datetime', fieldName: 'occurred_at' }) occurredAt = new Date();
  @Property({ type: 'integer' }) attempts = 0;
  @Property({ type: 'datetime', fieldName: 'next_attempt_at', nullable: true }) nextAttemptAt?: Date;
  @Property({ type: 'datetime', fieldName: 'published_at', nullable: true }) publishedAt?: Date;
}
