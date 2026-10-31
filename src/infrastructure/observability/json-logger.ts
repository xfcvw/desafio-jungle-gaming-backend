import type { LoggerService } from '@nestjs/common';

/** Evita logs formatados que dificultam busca e nunca serializa payloads de aposta. */
export class JsonLogger implements LoggerService {
  public log(message: unknown, context?: string): void { this.write('info', message, context); }
  public error(message: unknown, trace?: string, context?: string): void { this.write('error', message, context, trace); }
  public warn(message: unknown, context?: string): void { this.write('warn', message, context); }
  public debug(message: unknown, context?: string): void { this.write('debug', message, context); }
  public verbose(message: unknown, context?: string): void { this.write('debug', message, context); }

  private write(level: string, message: unknown, context?: string, trace?: string): void {
    const details = message && typeof message === 'object' ? message as Record<string, unknown> : { message };
    process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level, context, ...details, ...(trace ? { trace } : {}) })}\n`);
  }
}
