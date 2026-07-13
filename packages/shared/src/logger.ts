import pino from 'pino';
import { ConfigError } from './errors.js';
import { REDACT_PATHS, REDACTED_PLACEHOLDER, redactValue, redactObject } from './redactor.js';

export type Logger = pino.Logger;

const VALID_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
type LogLevel = (typeof VALID_LEVELS)[number];

let baseLogger: Logger | null = null;
let baseLoggerMode: 'production' | 'pretty' | null = null;

function getLoggerMode(): 'production' | 'pretty' {
  return process.env.NODE_ENV === 'production' ? 'production' : 'pretty';
}

function isValidLevel(level: string): level is LogLevel {
  return (VALID_LEVELS as readonly string[]).includes(level);
}

function resolveLevel(): LogLevel {
  const level = process.env.LOG_LEVEL ?? 'info';
  if (!isValidLevel(level)) {
    throw new ConfigError(`Invalid LOG_LEVEL "${level}". Valid levels: ${VALID_LEVELS.join(', ')}`);
  }
  return level;
}

function getBaseLogger(level: string): Logger {
  const mode = getLoggerMode();
  if (baseLogger && baseLoggerMode === mode) {
    baseLogger.level = level;
    return baseLogger;
  }

  baseLoggerMode = mode;
  baseLogger = pino({
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
      // (fast-redact paths do NOT cover arbitrary depth recursion).
      log: (obj) => redactObject(obj),
    },
    transport:
      mode !== 'production' ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
  });

  return baseLogger;
}

export function createLogger(name: string): Logger {
  const level = resolveLevel();
  return getBaseLogger(level).child({ name });
}

export function createLoggerWithContext(
  name: string,
  context: { tenantId?: string; jobId?: string; requestId?: string },
): Logger {
  const base = createLogger(name);
  const defined = Object.fromEntries(Object.entries(context).filter(([, v]) => v !== undefined));
  return base.child(defined);
}
