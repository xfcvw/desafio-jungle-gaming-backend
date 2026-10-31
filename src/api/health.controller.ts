import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { SqsTransport } from '../infrastructure/messaging/sqs.transport';

@Controller('health')
export class HealthController {
  public constructor(private readonly em: EntityManager, private readonly sqs: SqsTransport) {}
  @Get('live') public live() { return { status: 'ok' }; }
  @Get('ready')
  public async ready() {
    try {
      await this.em.getConnection().execute('select 1');
      await this.sqs.assertReachable();
      return { status: 'ok', database: 'reachable', sqs: 'reachable' };
    } catch {
      throw new ServiceUnavailableException({ status: 'not_ready', database: 'unreachable' });
    }
  }
}
