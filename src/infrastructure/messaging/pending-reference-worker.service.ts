import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { WageringService } from '../../application/wagering.service';

/** Mantém a recuperação de mensagens fora de ordem independente do consumidor SQS. */
@Injectable()
export class PendingReferenceWorkerService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PendingReferenceWorkerService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  public constructor(private readonly wagering: WageringService) {}

  public onModuleInit(): void {
    if (process.env.RUN_WORKERS === 'false') return;
    this.timer = setInterval(() => void this.run(), 5_000);
    this.timer.unref();
    void this.run();
  }

  public onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.wagering.reprocessPendingReferences();
    } catch (error) {
      this.logger.error({ message: 'Pending reference reprocessing failed.', error: error instanceof Error ? error.message : 'unknown' });
    } finally {
      this.running = false;
    }
  }
}
