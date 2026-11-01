import { Controller, Get } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { MetricsService } from '../infrastructure/observability/metrics.service';
import { SqsTransport } from '../infrastructure/messaging/sqs.transport';

@Controller('metrics')
export class MetricsController {
  public constructor(private readonly metrics: MetricsService, private readonly em: EntityManager, private readonly sqs: SqsTransport) {}

  @Get()
  public async snapshot() {
    const [outbox] = await this.em.getConnection().execute<Array<{ lag_seconds: string }>>(
      `select coalesce(extract(epoch from now() - min(occurred_at)), 0)::text as lag_seconds from outbox_messages where published_at is null`,
    );
    this.metrics.setGauge('outbox_lag_seconds', Number(outbox?.lag_seconds ?? 0));
    try {
      this.metrics.setGauge('wager_dlq_messages', await this.sqs.getWagerDlqDepth());
    } catch {
      this.metrics.setGauge('wager_dlq_messages', -1);
    }
    return this.metrics.snapshot();
  }
}
