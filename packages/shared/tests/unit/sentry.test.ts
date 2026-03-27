import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  withScope: vi.fn((cb) => cb({ setExtra: vi.fn() })),
}));

import { initSentry, captureException } from '../../src/sentry.js';
import * as Sentry from '@sentry/node';

describe('sentry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SENTRY_DSN;
  });

  it('does nothing when DSN is not set', () => {
    initSentry();
    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it('initializes when DSN is provided', () => {
    initSentry({ dsn: 'https://test@sentry.io/123' });
    expect(Sentry.init).toHaveBeenCalledWith(expect.objectContaining({ dsn: 'https://test@sentry.io/123' }));
  });

  it('captureException calls Sentry.captureException', () => {
    const error = new Error('test');
    captureException(error);
    expect(Sentry.captureException).toHaveBeenCalledWith(error);
  });
});
