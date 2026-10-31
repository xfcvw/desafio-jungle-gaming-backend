import { Migration } from '@mikro-orm/migrations';

export class Migration20261030000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create type wager_kind as enum ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK');`);
    this.addSql(`create type wager_status as enum ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED');`);
    this.addSql(`create type ledger_direction as enum ('DEBIT','CREDIT');`);
    this.addSql(`create table wallets (id uuid primary key, player_id varchar(255) not null, currency char(3) not null, balance numeric(20,2) not null check (balance >= 0), version integer not null default 1 check (version >= 1), created_at timestamptz not null, updated_at timestamptz not null, constraint wallet_player_currency_unique unique (player_id, currency));`);
    this.addSql(`create table wager_transactions (id uuid primary key, provider_id varchar(255) not null, external_transaction_id varchar(255) not null, idempotency_key varchar(512) not null, payload_hash char(64) not null, wallet_id uuid not null references wallets(id), player_id varchar(255) not null, round_id varchar(255) not null, game_id varchar(255) not null, kind wager_kind not null, amount numeric(20,2) not null check (amount >= 0), currency char(3) not null, reference_external_transaction_id varchar(255), status wager_status not null, reference_transaction_id uuid references wager_transactions(id), failure_code varchar(64), observed_balance_amount numeric(20,2), processed_at timestamptz, created_at timestamptz not null, constraint wager_idempotency_key_unique unique (idempotency_key), constraint wager_provider_external_unique unique (provider_id, external_transaction_id));`);
    this.addSql(`create index wager_reference_lookup_idx on wager_transactions (provider_id, external_transaction_id);`);
    this.addSql(`create table wallet_ledger_entries (id uuid primary key, wallet_id uuid not null references wallets(id), transaction_id uuid not null references wager_transactions(id), direction ledger_direction not null, amount numeric(20,2) not null check (amount > 0), currency char(3) not null, balance_before numeric(20,2) not null check (balance_before >= 0), balance_after numeric(20,2) not null check (balance_after >= 0), created_at timestamptz not null, constraint ledger_transaction_unique unique (transaction_id));`);
    this.addSql(`create index ledger_wallet_cursor_idx on wallet_ledger_entries (wallet_id, created_at, id);`);
    this.addSql(`create table inbox_messages (id uuid primary key, consumer_name varchar(255) not null, message_id varchar(255) not null, payload_hash char(64) not null, received_at timestamptz not null, processed_at timestamptz, constraint inbox_consumer_message_unique unique (consumer_name, message_id));`);
    this.addSql(`create table outbox_messages (id uuid primary key, aggregate_id uuid not null, event_type varchar(255) not null, payload jsonb not null, occurred_at timestamptz not null, attempts integer not null default 0 check (attempts >= 0), next_attempt_at timestamptz, published_at timestamptz);`);
    this.addSql(`create index outbox_pending_idx on outbox_messages (published_at, next_attempt_at);`);
    this.addSql(`create function forbid_ledger_mutation() returns trigger language plpgsql as $$ begin raise exception 'Ledger entries are immutable'; end; $$;`);
    this.addSql(`create trigger ledger_no_update before update or delete on wallet_ledger_entries for each row execute function forbid_ledger_mutation();`);
  }
  override async down(): Promise<void> {
    this.addSql('drop table if exists outbox_messages; drop table if exists inbox_messages; drop table if exists wallet_ledger_entries; drop table if exists wager_transactions; drop table if exists wallets; drop function if exists forbid_ledger_mutation; drop type if exists ledger_direction; drop type if exists wager_status; drop type if exists wager_kind;');
  }
}
