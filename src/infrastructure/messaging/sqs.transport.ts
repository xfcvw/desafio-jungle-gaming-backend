import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { Injectable } from '@nestjs/common';

const ACCOUNT_ID = '000000000000';

@Injectable()
export class SqsTransport {
  private readonly endpoint = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';
  private readonly client = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: this.endpoint,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });

  private readonly wagersQueueUrl = process.env.WAGER_TRANSACTIONS_QUEUE_URL ?? `${this.endpoint}/${ACCOUNT_ID}/wager-transactions.fifo`;
  private readonly wagersDlqQueueUrl = process.env.WAGER_TRANSACTIONS_DLQ_QUEUE_URL ?? `${this.endpoint}/${ACCOUNT_ID}/wager-transactions-dlq.fifo`;
  private readonly eventsQueueUrl = process.env.WAGER_EVENTS_QUEUE_URL ?? `${this.endpoint}/${ACCOUNT_ID}/wager-events.fifo`;

  public async receiveWagers(): Promise<Message[]> {
    const response = await this.client.send(new ReceiveMessageCommand({
      QueueUrl: this.wagersQueueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: Number(process.env.SQS_WAIT_TIME_SECONDS ?? 10),
      VisibilityTimeout: Number(process.env.SQS_VISIBILITY_TIMEOUT ?? 30),
      MessageSystemAttributeNames: ['ApproximateReceiveCount'],
    }));
    return response.Messages ?? [];
  }

  public async acknowledgeWager(message: Message): Promise<void> {
    if (!message.ReceiptHandle) return;
    await this.client.send(new DeleteMessageCommand({ QueueUrl: this.wagersQueueUrl, ReceiptHandle: message.ReceiptHandle }));
  }

  public async releaseWager(message: Message): Promise<void> {
    if (!message.ReceiptHandle) return;
    await this.client.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.wagersQueueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: 0 }));
  }

  public async publishIntegrationEvent(payload: Record<string, unknown>, aggregateId: string, eventId: string): Promise<void> {
    await this.client.send(new SendMessageCommand({
      QueueUrl: this.eventsQueueUrl,
      MessageBody: JSON.stringify(payload),
      MessageGroupId: aggregateId,
      MessageDeduplicationId: eventId,
    }));
  }

  /** Publicação usada por provedores/integrações e pelos testes de fila real. */
  public async publishWagerRequest(payload: Record<string, unknown>, walletId: string, deduplicationId: string): Promise<void> {
    await this.client.send(new SendMessageCommand({
      QueueUrl: this.wagersQueueUrl,
      MessageBody: JSON.stringify(payload),
      MessageGroupId: walletId,
      MessageDeduplicationId: deduplicationId,
    }));
  }

  /** Usado apenas pela suíte de integração para isolar execuções entre si. */
  public async purgeWagersForTest(): Promise<void> {
    await this.client.send(new PurgeQueueCommand({ QueueUrl: this.wagersQueueUrl }));
    await this.client.send(new PurgeQueueCommand({ QueueUrl: this.wagersDlqQueueUrl }));
  }

  public async receiveWagerDeadLetters(): Promise<Message[]> {
    const response = await this.client.send(new ReceiveMessageCommand({
      QueueUrl: this.wagersDlqQueueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: Number(process.env.SQS_WAIT_TIME_SECONDS ?? 10),
    }));
    return response.Messages ?? [];
  }

  public async assertReachable(): Promise<void> {
    await Promise.all([this.wagersQueueUrl, this.eventsQueueUrl].map((QueueUrl) => this.client.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] }))));
  }
}
