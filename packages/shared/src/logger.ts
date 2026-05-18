import pino from 'pino';
import { ConfigError } from './errors.js';

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
