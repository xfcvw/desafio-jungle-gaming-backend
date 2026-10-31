import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import mikroConfig from '../mikro-orm.config';
import { WageringService } from './application/wagering.service';
import { HealthController } from './api/health.controller';
import { WageringController } from './api/wagering.controller';
import { SqsTransport } from './infrastructure/messaging/sqs.transport';
import { OutboxPublisherService } from './infrastructure/messaging/outbox-publisher.service';
import { WagerConsumerService } from './infrastructure/messaging/wager-consumer.service';

@Module({
  imports: [MikroOrmModule.forRoot(mikroConfig)],
  controllers: [HealthController, WageringController],
  providers: [WageringService, SqsTransport, OutboxPublisherService, WagerConsumerService],
})
export class AppModule {}
