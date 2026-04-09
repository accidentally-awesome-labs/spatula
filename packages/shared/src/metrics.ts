import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import type { Histogram, Counter, UpDownCounter, Meter } from '@opentelemetry/api';
import { createLogger } from './logger.js';

const logger = createLogger('metrics');

let meterProvider: MeterProvider | undefined;
let _meter: Meter | undefined;

export interface MetricsConfig {
  enabled?: boolean;
  port?: number;
}

export interface SpatulaMetrics {
  httpRequestDuration: Histogram;
  httpRequestsTotal: Counter;
  httpActiveConnections: UpDownCounter;
  queueJobDuration: Histogram;
  queueJobsTotal: Counter;
  llmTokensUsed: Counter;
  llmRequestDuration: Histogram;
  llmCostUsd: Counter;
  pagesProcessedTotal: Counter;
  pageCrawlDuration: Histogram;
  entitiesCreatedTotal: Counter;
  exportSizeBytes: Histogram;
  circuitBreakerState: UpDownCounter;
  circuitBreakerRejectionsTotal: Counter;
}

export function createMetrics(config?: MetricsConfig): SpatulaMetrics {
  const enabled = config?.enabled ?? !!process.env.OTEL_EXPORTER_ENDPOINT;
  const port = config?.port ?? 9464;

  if (enabled) {
    const exporter = new PrometheusExporter({ port, preventServerStart: false });
    meterProvider = new MeterProvider({ readers: [exporter] });
    logger.info({ port }, 'Prometheus metrics exporter started');
  } else {
    meterProvider = new MeterProvider();
  }

  const meter = meterProvider.getMeter('spatula');
  _meter = meter;

  return {
    httpRequestDuration: meter.createHistogram('http_request_duration_ms', { description: 'HTTP request duration in milliseconds', unit: 'ms' }),
    httpRequestsTotal: meter.createCounter('http_requests_total', { description: 'Total HTTP requests' }),
    httpActiveConnections: meter.createUpDownCounter('http_active_connections', { description: 'Active HTTP connections' }),
    queueJobDuration: meter.createHistogram('queue_job_duration_ms', { description: 'Queue job duration in milliseconds', unit: 'ms' }),
    queueJobsTotal: meter.createCounter('queue_jobs_total', { description: 'Total queue jobs processed' }),
    llmTokensUsed: meter.createCounter('llm_tokens_used', { description: 'Total LLM tokens consumed' }),
    llmRequestDuration: meter.createHistogram('llm_request_duration_ms', { description: 'LLM request duration in milliseconds', unit: 'ms' }),
    llmCostUsd: meter.createCounter('llm_cost_usd', { description: 'Total LLM cost in USD' }),
    pagesProcessedTotal: meter.createCounter('pages_processed_total', { description: 'Total pages crawled' }),
    pageCrawlDuration: meter.createHistogram('page_crawl_duration_ms', { description: 'Page crawl duration in milliseconds', unit: 'ms' }),
    entitiesCreatedTotal: meter.createCounter('entities_created_total', { description: 'Total entities created' }),
    exportSizeBytes: meter.createHistogram('export_size_bytes', { description: 'Export file size in bytes', unit: 'bytes' }),
    circuitBreakerState: meter.createUpDownCounter('circuit_breaker_state', { description: 'Circuit breaker state' }),
    circuitBreakerRejectionsTotal: meter.createCounter('circuit_breaker_rejections_total', { description: 'Circuit breaker rejections' }),
  };
}

export function registerGauges(
  deps: {
    jobRepo: { countByStatus: (status: string) => Promise<number> };
    tenantRepo: { countAll: () => Promise<number> };
    queueProvider: { getQueueDepth: () => Promise<number> };
  },
): void {
  if (!_meter) return;

  _meter.createObservableGauge('active_jobs', { description: 'Currently running jobs' })
    .addCallback(async (result) => {
      try { result.observe(await deps.jobRepo.countByStatus('running')); }
      catch { result.observe(0); }
    });

  _meter.createObservableGauge('tenant_count', { description: 'Total tenants' })
    .addCallback(async (result) => {
      try { result.observe(await deps.tenantRepo.countAll()); }
      catch { result.observe(0); }
    });

  _meter.createObservableGauge('queue_depth', { description: 'Total pending queue items' })
    .addCallback(async (result) => {
      try { result.observe(await deps.queueProvider.getQueueDepth()); }
      catch { result.observe(0); }
    });
}

export async function shutdownMetrics(): Promise<void> {
  if (meterProvider) {
    await meterProvider.shutdown();
    meterProvider = undefined;
    _meter = undefined;
  }
}
