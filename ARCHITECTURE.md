# Decisões de arquitetura

## Dinheiro e ledger

O contrato de dinheiro é `{ amount: string, currency: string }`. A classe `Money` aceita escala fixa de duas casas e usa `decimal.js`; `number` não é usado em valores financeiros. O PostgreSQL persiste valores em `numeric(20,2)`.

`wallet_ledger_entries` é a evidência auditável de cada movimento. Há unicidade por `transaction_id`, trigger que bloqueia `UPDATE` e `DELETE` e trigger que valida moeda e aritmética do lançamento no banco. `wallets.balance` é materializado para leitura rápida; a reconciliação o compara com a soma do ledger e não corrige divergências silenciosamente.

## Concorrência

A unidade de concorrência é a carteira. O processamento usa `FOR UPDATE` na linha da carteira dentro de uma transação SQL. Carteiras diferentes permanecem independentes. Duas apostas de `80.00` contra saldo `100.00` resultam em uma `PROCESSED`, uma `REJECTED` e saldo final `20.00`.

O `CHECK (balance >= 0)` é defesa adicional; não substitui o lock.

## Idempotência e mensageria

`Idempotency-Key` possui unicidade persistida em `wager_transactions`. O payload de negócio é normalizado com chaves ordenadas e armazenado como SHA-256. Chave e hash iguais devolvem o resultado original; chave igual e hash diferente gera conflito.

Carteira, lançamento, status da transação, Inbox e Outbox participam da mesma transação. A Outbox usa `FOR UPDATE SKIP LOCKED`; uma publicação duplicada continua segura porque os consumidores deduplicam pelo `eventId`. O consumidor SQS confirma a mensagem apenas depois do commit; falhas transitórias ficam para retry e a fila as envia à DLQ após cinco recebimentos.

## Referências fora de ordem

`REFUND` e `ROLLBACK` sem referência ficam em `PENDING_REFERENCE`. Um worker separado executa a cada cinco segundos, aplica backoff exponencial e faz até dez tentativas. Ao esgotar, a transação torna-se `REJECTED` com `REFERENCE_NOT_FOUND`.

## Observabilidade

Os logs são JSON estruturado e não recebem payload financeiro completo. O endpoint `/metrics` expõe contadores de transações, replays idempotentes, publicação/retry da Outbox e processamento da Inbox. Essas métricas não fazem parte da garantia financeira.

## Autenticação

Autenticação foi deixada fora do escopo funcional, como permitido pelo enunciado. O ponto de extensão deve ser um `Guard` do Nest integrado a OIDC externo, como Keycloak ou Zitadel, nunca uma tabela própria de senhas. Health checks continuam públicos.

## Limitações e próximos incrementos

- Faltam cenários automatizados para três ou mais processos, queda entre commit e `ack`, dois publishers simultâneos e reinício completo do serviço.
- As métricas estão em memória; em produção devem ser exportadas para Prometheus ou OpenTelemetry.
- Antes de expor a API fora do ambiente de avaliação, adicionar autenticação OIDC, rate limiting e política de implantação.
