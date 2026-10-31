import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { InboxMessageEntity, OutboxMessageEntity, WalletEntity, WalletLedgerEntryEntity, WagerTransactionEntity } from './src/infrastructure/persistence/entities';

export default defineConfig({
  entities: [WalletEntity, WagerTransactionEntity, WalletLedgerEntryEntity, InboxMessageEntity, OutboxMessageEntity],
  clientUrl: process.env.DATABASE_URL ?? 'postgresql://jungle:jungle@localhost:5432/jungle_wagering',
  extensions: [Migrator],
  migrations: { path: './src/infrastructure/persistence/migrations', pathTs: './src/infrastructure/persistence/migrations' },
});
