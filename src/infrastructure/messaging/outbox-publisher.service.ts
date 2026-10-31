import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { OutboxMessageEntity } from '../persistence/entities';
import { SqsTransport } from './sqs.transport';

interface ClaimedOutboxMessage { id: string; aggregateId: string; payload: Record<string, unknown>; attempts: number }

@Injectable()
export class OutboxPublisherService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxPublisherService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  public constructor(private readonly em: EntityManager, private readonly sqs: SqsTransport) {}

  public onModuleInit(): void {
    if (process.env.RUN_WORKERS === 'false') return;
    this.timer = setInterval(() => void this.publishDue(), 1_000);
    this.timer.unref();
    void this.publishDue();
  }

  public onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  public async publishDue(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const message of await this.claimBatch()) {
        try {
          const eventId = typeof message.payload.eventId === 'string' ? message.payload.eventId : message.id;
          await this.sqs.publishIntegrationEvent(message.payload, message.aggregateId, eventId);
          await this.em.fork().nativeUpdate(OutboxMessageEntity, { id: message.id, publishedAt: null }, { publishedAt: new Date() });
        } catch (error) {
          await this.scheduleRetry(message);
          this.logger.warn({ message: 'Outbox publication failed; scheduled retry.', outboxMessageId: message.id, attempt: message.attempts, error: error instanceof Error ? error.message : 'unknown' });
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async claimBatch(): Promise<ClaimedOutboxMessage[]> {
    const fork = this.em.fork();
    return fork.transactional(async (em) => {
      const rows = await em.getConnection().execute<{ id: string }[]>(`
        select id from outbox_messages
        where published_at is null and (next_attempt_at is null or next_attempt_at <= now())
        order by occurred_at asc
        for update skip locked
        limit 20
      `);
      if (rows.length === 0) return [];
      const ids = rows.map((row) => row.id);
      const messages = await em.find(OutboxMessageEntity, { id: { $in: ids } });
      const leaseUntil = new Date(Date.now() + 30_000);
      for (const message of messages) {
        message.attempts += 1;
        message.nextAttemptAt = leaseUntil;
      }
      await em.flush();
      return messages.map((message) => ({ id: message.id, aggregateId: message.aggregateId, payload: message.payload, attempts: message.attempts }));
    });
  }

  private async scheduleRetry(message: ClaimedOutboxMessage): Promise<void> {
    const seconds = Math.min(300, 2 ** Math.min(message.attempts, 8));
    await this.em.fork().nativeUpdate(OutboxMessageEntity, { id: message.id, publishedAt: null }, { nextAttemptAt: new Date(Date.now() + seconds * 1_000) });
  }
}
