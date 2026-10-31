import { Migration } from '@mikro-orm/migrations';

/**
 * Proteções que precisam existir no PostgreSQL, mesmo se outro processo ou uma
 * ferramenta administrativa tentar gravar diretamente no ledger.
 */
export class Migration20261031000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table wager_transactions add column reference_attempts integer not null default 0 check (reference_attempts >= 0), add column next_reference_attempt_at timestamptz;`);
    this.addSql(`create index wager_pending_reference_idx on wager_transactions (status, next_reference_attempt_at) where status = 'PENDING_REFERENCE';`);
    this.addSql(`
      create function validate_ledger_entry() returns trigger language plpgsql as $$
      declare wallet_currency char(3);
      begin
        select currency into wallet_currency from wallets where id = new.wallet_id;
        if wallet_currency is null then
          raise exception 'Wallet % does not exist', new.wallet_id;
        end if;
        if new.currency <> wallet_currency then
          raise exception 'Ledger currency must match wallet currency';
        end if;
        if (new.direction = 'CREDIT' and new.balance_after <> new.balance_before + new.amount)
          or (new.direction = 'DEBIT' and new.balance_after <> new.balance_before - new.amount) then
          raise exception 'Ledger entry arithmetic is invalid';
        end if;
        return new;
      end;
      $$;
    `);
    this.addSql(`create trigger ledger_validate_before_insert before insert on wallet_ledger_entries for each row execute function validate_ledger_entry();`);
  }

  override async down(): Promise<void> {
    this.addSql('drop trigger if exists ledger_validate_before_insert on wallet_ledger_entries; drop function if exists validate_ledger_entry; drop index if exists wager_pending_reference_idx; alter table wager_transactions drop column if exists next_reference_attempt_at, drop column if exists reference_attempts;');
  }
}
