import { Injectable } from '@nestjs/common';

/** Contadores operacionais; não participam de nenhuma garantia financeira. */
@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();

  public increment(name: string, labels: Record<string, string> = {}): void {
    const key = `${name}${Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `:${key}=${value}`).join('')}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  public observe(name: string, value: number): void {
    const safeValue = Number.isFinite(value) ? value : 0;
    this.increment(`${name}_count`);
    this.counters.set(`${name}_sum`, (this.counters.get(`${name}_sum`) ?? 0) + safeValue);
  }

  public setGauge(name: string, value: number): void {
    this.gauges.set(name, Number.isFinite(value) ? value : 0);
  }

  public snapshot(): Record<string, number> {
    return Object.fromEntries([...this.counters.entries(), ...this.gauges.entries()]);
  }
}
