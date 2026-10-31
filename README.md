# Distributed Wagering Processor

Implementation of the Jungle Gaming backend challenge. The project is organized around financial invariants first: exact money, immutable ledger, database-enforced idempotency and wallet-scoped concurrency.

## Current milestone

- NestJS + TypeScript strict mode + Bun scripts;
- PostgreSQL schema/migration with constraints and immutable ledger trigger;
- `Money`, `Wallet`, ledger and transaction domain types;
- wallet creation with internal `OPENING` transaction and ledger entry;
- synchronous HTTP submission for `BET`, `WIN`, `LOSS`, `REFUND` and `ROLLBACK`;
- persisted idempotency key and canonical SHA-256 payload hash;
- row-level wallet lock (`FOR UPDATE`) to prevent lost updates;
- transactional outbox records plus a concurrent `SKIP LOCKED` publisher;
- SQS consumer with persistent Inbox deduplication, delayed retry and DLQ handoff;
- unit tests for exact money and wallet invariants.

The next milestone adds container-based integration tests, concurrent multi-process tests, scheduled reprocessing of out-of-order references, reconciliation and cursor-based queries.

## Run locally

Prerequisites: Bun 1.x and Docker Compose.

```bash
cp .env.example .env
bun install
docker compose up -d
bun run migration:up
bun run start:dev
```

Run the unit tests:

```bash
bun test test/unit
```

## HTTP examples

Create a wallet:

```bash
curl -X POST http://localhost:3000/wallets \
  -H 'content-type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"100.00","currency":"BRL"}}'
```

Submit a bet, replacing the wallet ID returned above:

```bash
curl -X POST http://localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:bet-001' \
  -d '{"providerId":"provider-a","externalTransactionId":"bet-001","playerId":"player-1","walletId":"<wallet-id>","roundId":"round-1","gameId":"game-1","kind":"BET","money":{"amount":"80.00","currency":"BRL"}}'
```

Repeat exactly the same request and key to receive the original result with `idempotentReplay: true`. Reusing that key with a different payload returns HTTP 409.

## Endpoints currently exposed

| Endpoint | Purpose |
| --- | --- |
| `POST /wallets` | Create a wallet and initial opening credit |
| `GET /wallets/:walletId` | Read a wallet balance and version |
| `POST /wagering/transactions` | Submit a wager operation with `Idempotency-Key` |
| `GET /health/live` | Process liveness |
| `GET /health/ready` | PostgreSQL and SQS readiness |

Architecture and trade-offs are documented in [ARCHITECTURE.md](ARCHITECTURE.md).
