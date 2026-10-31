import { Injectable } from '@nestjs/common';

/** Contadores operacionais; não participam de nenhuma garantia financeira. */
@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, number>();

  public increment(name: string, labels: Record<string, string> = {}): void {
    const key = `${name}${Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `:${key}=${value}`).join('')}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  public snapshot(): Record<string, number> {
    return Object.fromEntries(this.counters.entries());
  }
}
