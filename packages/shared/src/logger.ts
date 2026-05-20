import pino from 'pino';
import { ConfigError } from './errors.js';
import { REDACT_PATHS, REDACTED_PLACEHOLDER, redactValue, redactObject } from './redactor.js';

export type Logger = pino.Logger;

const VALID_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

export function createLogger(name: string): Logger {
  const level = process.env.LOG_LEVEL ?? 'info';
  if (!VALID_LEVELS.includes(level as any)) {
    throw new ConfigError(`Invalid LOG_LEVEL "${level}". Valid levels: ${VALID_LEVELS.join(', ')}`);
  }
  return pino({
    name,
    level,
    redact: { paths: REDACT_PATHS, censor: REDACTED_PLACEHOLDER },
    serializers: {
      // Scan err.message for secret-shaped strings after standard serialization
      err: (err: Error) => {
        const s = pino.stdSerializers.err(err);
        if (s.message) s.message = redactValue(s.message);
        return s;
      },
    },
    formatters: {
      // Value-scan backstop: walk all logged object fields for secrets at unknown nesting depths
      // (Pitfall 1: fast-redact paths do NOT cover arbitrary depth recursion)
      log: (obj) => redactObject(obj),
    },
    transport:
      process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  });
}

export function createLoggerWithContext(
  name: string,
  context: { tenantId?: string; jobId?: string; requestId?: string },
): Logger {
  const base = createLogger(name);
  const defined = Object.fromEntries(Object.entries(context).filter(([, v]) => v !== undefined));
  return base.child(defined);
}
