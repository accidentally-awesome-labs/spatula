import { context, propagation, trace, SpanKind } from '@opentelemetry/api';

export function injectTraceContext<T extends Record<string, unknown>>(data: T): T & { _traceContext?: Record<string, string> } {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  if (Object.keys(carrier).length === 0) return data;
  return { ...data, _traceContext: carrier };
}

export function extractTraceContext(
  jobData: Record<string, unknown>,
  spanName: string,
): { cleanup: () => void } {
  const carrier = jobData._traceContext as Record<string, string> | undefined;
  if (!carrier) return { cleanup: () => {} };

  const parentContext = propagation.extract(context.active(), carrier);
  const tracer = trace.getTracer('spatula-worker');
  const span = tracer.startSpan(spanName, { kind: SpanKind.CONSUMER }, parentContext);

  return { cleanup: () => span.end() };
}
