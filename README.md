# Processador Distribuído de Apostas — Desafio Jungle Gaming

Implementação do desafio técnico da Jungle Gaming. O foco é manter a correção financeira mesmo com reentregas, concorrência na mesma carteira e falhas temporárias da fila.

## Tecnologias

- Bun 1.x, TypeScript estrito e NestJS;
- PostgreSQL e MikroORM com migrations reversíveis;
- AWS SQS via LocalStack e Docker Compose;
- `decimal.js` para valores monetários exatos.

## Garantias implementadas

- Dinheiro usa somente strings decimais com duas casas; não há `number` em valores financeiros.
- Uma carteira é única para `playerId + currency` e seu saldo não pode ser negativo.
- Toda alteração financeira cria um lançamento imutável no ledger.
- O PostgreSQL bloqueia alteração/remoção do ledger e valida sua aritmética.
- A `Idempotency-Key` e o hash SHA-256 do payload são persistidos. Reenvio idêntico devolve a resposta original; mesma chave com payload diferente gera conflito.
- O lock pessimista `FOR UPDATE` é por carteira, evitando *lost update* sem bloquear carteiras diferentes.
- Wallet, transação, ledger, Inbox e Outbox são gravados na mesma transação SQL.
- A Outbox usa `FOR UPDATE SKIP LOCKED`; o consumidor SQS confirma a mensagem somente após o commit.
- `REFUND` e `ROLLBACK` sem referência ficam em `PENDING_REFERENCE`, com backoff e expiração após dez tentativas.

## Como executar localmente

Pré-requisitos: Docker Desktop e Bun 1.x.

```bash
cp .env.example .env
bun install
docker compose up -d
bun run migration:up
bun run start:dev
```

No PowerShell:

```powershell
copy .env.example .env
```

Se a porta `5432` estiver ocupada, altere a porta exposta no `docker-compose.yml` e a `DATABASE_URL` apenas no seu `.env`. O `.env` não entra no Git.

## Testes e validações

Com os containers ativos:

```bash
bun run lint
bun run test:unit
RUN_WORKERS=false bun run test:integration
```

Os testes de integração usam PostgreSQL e LocalStack reais e cobrem cinquenta entregas idênticas em paralelo, três instâncias da API, duas apostas disputando saldo, reconciliação do ledger, redelivery deduplicado pela Inbox e dois publishers concorrentes na Outbox.

## Endpoints

| Método e rota | Finalidade |
| --- | --- |
| `POST /wallets` | Cria carteira e crédito interno `OPENING`. |
| `GET /wallets/:walletId` | Consulta saldo e versão. |
| `GET /wallets/:walletId/ledger?cursor=&limit=50` | Lista o ledger com cursor opaco. |
| `POST /wallets/:walletId/reconciliation` | Recalcula o saldo a partir do ledger. |
| `POST /wagering/transactions` | Recebe `BET`, `WIN`, `LOSS`, `REFUND` ou `ROLLBACK`. Exige `Idempotency-Key`. |
| `GET /wagering/transactions/:transactionId` | Consulta uma transação. |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta por transação externa. |
| `GET /health/live` e `GET /health/ready` | Saúde do processo, PostgreSQL e SQS. |
| `GET /metrics` | Contadores operacionais em JSON. |

## Exemplo rápido

```bash
curl -X POST http://localhost:3000/wallets \
  -H 'content-type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"100.00","currency":"BRL"}}'
```

```bash
curl -X POST http://localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:bet-001' \
  -d '{"providerId":"provider-a","externalTransactionId":"bet-001","playerId":"player-1","walletId":"<wallet-id>","roundId":"round-1","gameId":"game-1","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

Repetir a requisição idêntica retorna `idempotentReplay: true`. Reutilizar a chave com outro payload retorna HTTP 409.

Consulte [ARCHITECTURE.md](ARCHITECTURE.md) para as decisões e limitações conhecidas.
