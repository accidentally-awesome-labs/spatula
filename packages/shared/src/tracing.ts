import { NodeTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { createLogger } from './logger.js';

const logger = createLogger('tracing');

let tracerProvider: NodeTracerProvider | undefined;

export interface TracingConfig {
  serviceName?: string;
  endpoint?: string;
}

export function initTracing(config?: TracingConfig): void {
  const endpoint = config?.endpoint ?? process.env.OTEL_EXPORTER_ENDPOINT;
  if (!endpoint) {
    logger.debug('OTEL_EXPORTER_ENDPOINT not set, tracing disabled');
    return;
  }

  const serviceName = config?.serviceName ?? 'spatula-api';
  const exporter = new OTLPTraceExporter({ url: `${endpoint}/v1/traces` });

  tracerProvider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });

  tracerProvider.register();

  registerInstrumentations({
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  logger.info({ endpoint, serviceName }, 'Distributed tracing initialized');
}

export async function shutdownTracing(): Promise<void> {
  if (tracerProvider) {
    await tracerProvider.shutdown();
    tracerProvider = undefined;
  }
}
