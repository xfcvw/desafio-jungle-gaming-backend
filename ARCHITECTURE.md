# Architecture decisions

## Money and ledger

External money is always `{ amount: string, currency: string }`. `Money` accepts only a fixed two-decimal string and uses `decimal.js`; JavaScript `number` is never used for a financial value. PostgreSQL persists the amount in `numeric(20,2)`.

`wallet_ledger_entries` is the source of audit evidence. It has one row per financial transaction, a unique constraint on `transaction_id`, checks for non-negative before/after balances and a database trigger that rejects any update or deletion. The materialized balance in `wallets` is fast to read, while reconciliation will rebuild it from the ledger.

## Concurrency

The concurrency boundary is a single wallet. The wager use case creates its transaction record and then obtains a PostgreSQL pessimistic row lock on that wallet inside one SQL transaction. Wallets with different IDs remain independent; operations for the same wallet serialize. This makes the required two simultaneous bets of 80.00 against 100.00 deterministic: one becomes `PROCESSED`, the other `REJECTED` with `INSUFFICIENT_FUNDS`.

The final database `CHECK (balance >= 0)` is defense in depth. It is not the sole concurrency strategy.

## Idempotency

The `Idempotency-Key` header is stored in `wager_transactions` under a unique constraint. The application creates a canonical JSON representation of the business payload (sorted keys) and stores its SHA-256. An equal key + equal hash returns the original stored outcome; an equal key + different hash is an explicit conflict. The database, not process memory, is authoritative when replicas race.

## Transactional boundary

Wallet mutation, ledger insertion, wager status and outbox rows use the same MikroORM/PostgreSQL transaction. An event cannot be stored without the associated financial result, and no message is published by the HTTP path before that commit.

The outbox publisher and SQS Inbox worker are separate adapters. Publishers claim pending rows with `FOR UPDATE SKIP LOCKED`, temporarily lease them through `next_attempt_at`, publish, then mark them as published. A crash after publication but before this final update can create a duplicate event; the stable event ID in the envelope allows downstream Inbox consumers to deduplicate it safely.

The wager consumer creates the Inbox record, executes the financial use case, writes its ledger/outbox records and marks the Inbox record as processed in one SQL transaction. It deletes the SQS message only after that transaction commits. Transient failures therefore remain visible for SQS retry and move to the FIFO DLQ after five receives. On shutdown, in-flight messages are allowed to finish for up to 20 seconds, then their visibility is returned to the queue.

## Reversals

`REFUND` only reverses a processed `BET`; `ROLLBACK` reverses a processed `BET`, `WIN` or `REFUND`. The reference must match provider, player, wallet, round, currency and amount. The unique ledger row and a query for an existing processed reversal prevent duplicate effects. Missing references are persisted as `PENDING_REFERENCE`; a scheduled retry worker will decide whether to process or eventually reject them.

## Authentication

Authentication is intentionally deferred, as the challenge permits. The extension boundary will be a Nest guard backed by an external OIDC provider (Keycloak or Zitadel), never a custom passwords table. Health endpoints stay unauthenticated.

## Known next work

1. Add scheduled reprocessing and expiry for `PENDING_REFERENCE` transactions.
2. Add ledger cursor pagination, transaction lookup and reconciliation endpoints.
3. Add container-based integration and multi-process concurrency tests.
4. Add structured metrics and correlation IDs to the log adapter.
