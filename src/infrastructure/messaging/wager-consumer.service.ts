import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import type { Message } from '@aws-sdk/client-sqs';
import { WagerTransactionKind } from '../../domain/transaction';
import { type QueueWagerMessage, WageringService } from '../../application/wagering.service';
import { SqsTransport } from './sqs.transport';
import { MetricsService } from '../observability/metrics.service';

interface WagerQueueEnvelope {
  messageId: string;
  type: 'WagerTransactionRequested';
  occurredAt: string;
  data: QueueWagerMessage['data'];
}

interface ConsumeOnceOptions {
  /** Permite que testes exercitem rapidamente as tentativas e a DLQ, sem aguardar o timeout de visibilidade. */
  releaseTransientFailures?: boolean;
}

@Injectable()
export class WagerConsumerService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(WagerConsumerService.name);
  private polling = false;
  private stopping = false;
  private readonly inFlight = new Map<string, Message>();

  public constructor(private readonly sqs: SqsTransport, private readonly wagering: WageringService, private readonly metrics: MetricsService) {}

  public onModuleInit(): void {
    if (process.env.RUN_WORKERS === 'false') return;
    void this.poll();
  }

  public async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    const deadline = Date.now() + 20_000;
    while (this.inFlight.size > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    await Promise.allSettled([...this.inFlight.values()].map((message) => this.sqs.releaseWager(message)));
  }

  /** Uma rodada determinística de consumo, útil para health checks operacionais e integração. */
  public async consumeOnce(options: ConsumeOnceOptions = {}): Promise<number> {
    const messages = await this.sqs.receiveWagers();
    await Promise.all(messages.map((message) => this.handle(message, options.releaseTransientFailures ?? false)));
    return messages.length;
  }

  private async poll(): Promise<void> {
    if (this.polling || this.stopping) return;
    this.polling = true;
    try {
      while (!this.stopping) {
        await this.consumeOnce();
      }
    } catch (error) {
      this.logger.error({ message: 'SQS polling failed; retrying shortly.', error: error instanceof Error ? error.message : 'unknown' });
      if (!this.stopping) setTimeout(() => void this.poll(), 2_000).unref();
    } finally {
      this.polling = false;
    }
  }

  private async handle(message: Message, releaseTransientFailures: boolean): Promise<void> {
    const trackingId = message.MessageId ?? message.ReceiptHandle ?? crypto.randomUUID();
    this.inFlight.set(trackingId, message);
    try {
      const envelope = this.parse(message);
      await this.wagering.submitFromQueue({ messageId: envelope.messageId, data: envelope.data });
      await this.sqs.acknowledgeWager(message);
      this.metrics.increment('inbox_messages_processed_total');
    } catch (error) {
      if (error instanceof InvalidQueueEnvelopeError) {
        this.logger.error({ message: 'Discarding malformed wager message.', sqsMessageId: message.MessageId, error: error.message });
        await this.sqs.acknowledgeWager(message);
        this.metrics.increment('inbox_messages_rejected_total');
      } else {
        // No acknowledgement: SQS retries and eventually routes the message to its DLQ.
        this.logger.error({ message: 'Wager message processing failed; leaving it for retry.', sqsMessageId: message.MessageId, error: error instanceof Error ? error.message : 'unknown' });
        this.metrics.increment('inbox_retries_total');
        if (releaseTransientFailures) await this.sqs.releaseWager(message);
      }
    } finally {
      this.inFlight.delete(trackingId);
    }
  }

  private parse(message: Message): WagerQueueEnvelope {
    if (!message.Body) throw new InvalidQueueEnvelopeError('Body is missing.');
    let value: unknown;
    try { value = JSON.parse(message.Body); } catch { throw new InvalidQueueEnvelopeError('Body is not JSON.'); }
    if (!value || typeof value !== 'object') throw new InvalidQueueEnvelopeError('Envelope is invalid.');
    const input = value as Partial<WagerQueueEnvelope>;
    if (input.type !== 'WagerTransactionRequested' || !input.messageId || !input.data || typeof input.data !== 'object') throw new InvalidQueueEnvelopeError('Envelope fields are invalid.');
    const data = input.data as Partial<QueueWagerMessage['data']>;
    if (!data.idempotencyKey || !data.providerId || !data.externalTransactionId || !data.playerId || !data.walletId || !data.roundId || !data.gameId || !data.money || !Object.values(WagerTransactionKind).includes(data.kind as WagerTransactionKind)) throw new InvalidQueueEnvelopeError('Transaction payload is invalid.');
    return input as WagerQueueEnvelope;
  }
}

class InvalidQueueEnvelopeError extends Error {}
