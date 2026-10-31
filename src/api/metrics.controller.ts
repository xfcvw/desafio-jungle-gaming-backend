import { Controller, Get } from '@nestjs/common';
import { MetricsService } from '../infrastructure/observability/metrics.service';

@Controller('metrics')
export class MetricsController {
  public constructor(private readonly metrics: MetricsService) {}
  @Get() public snapshot() { return this.metrics.snapshot(); }
}
