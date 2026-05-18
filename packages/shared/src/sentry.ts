import * as Sentry from '@sentry/node';
import { createLogger } from './logger.js';

const logger = createLogger('sentry');

export interface SentryConfig {
  dsn: string;
  environment?: string;
  tracesSampleRate?: number;
}

export function initSentry(config?: SentryConfig): void {
  const dsn = config?.dsn ?? process.env.SENTRY_DSN;
  if (!dsn) {
    logger.debug('SENTRY_DSN not set, Sentry disabled');
    return;
  }

  Sentry.init({
    dsn,
    environment: config?.environment ?? process.env.NODE_ENV ?? 'development',
    tracesSampleRate:
      config?.tracesSampleRate ?? parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0.1'),
  });
  logger.info('Sentry initialized');
}

export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (context) {
    Sentry.withScope((scope) => {
      for (const [key, value] of Object.entries(context)) {
        scope.setExtra(key, value);
      }
      Sentry.captureException(error);
    });
  } else {
    Sentry.captureException(error);
  }
}

export { Sentry };
