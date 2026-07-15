import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebhookSender } from '../../src/webhook-sender.js';
import type { WebhookEvent } from '@accidentally-awesome-labs/spatula-shared';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('@accidentally-awesome-labs/spatula-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@accidentally-awesome-labs/spatula-shared')>();
  return {
    ...actual,
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  };
});

function makeEvent(overrides?: Partial<WebhookEvent>): WebhookEvent {
  return {
    id: 'evt_test1',
    type: 'job.completed',
    timestamp: '2026-03-31T00:00:00Z',
    data: { jobId: 'job-1', tenantId: 'tenant-1', status: 'completed' },
    ...overrides,
  };
}

describe('WebhookSender', () => {
  const sender = new WebhookSender();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends a POST with JSON body and correct headers', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    const event = makeEvent();

    await sender.send('https://example.com/webhook', event);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://example.com/webhook');
    expect(options.method).toBe('POST');
    expect(options.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(options.body)).toEqual(event);
  });

  it('adds HMAC-SHA256 signature when secret is provided', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    const event = makeEvent({ id: 'evt_test2', type: 'job.failed' });

    await sender.send('https://example.com/webhook', event, 'my-secret-key-1234');

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers['X-Spatula-Signature']).toBeDefined();
    expect(options.headers['X-Spatula-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it('does not add signature when no secret', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    await sender.send('https://example.com/webhook', makeEvent());

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers['X-Spatula-Signature']).toBeUndefined();
  });

  it('throws on non-2xx response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' });

    await expect(sender.send('https://example.com/webhook', makeEvent())).rejects.toThrow(
      'Webhook delivery failed: 500',
    );
  });

  it('throws on network failure', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(sender.send('https://example.com/webhook', makeEvent())).rejects.toThrow(
      'ECONNREFUSED',
    );
  });

  it('uses AbortSignal for timeout', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    await sender.send('https://example.com/webhook', makeEvent());

    const [, options] = mockFetch.mock.calls[0];
    expect(options.signal).toBeDefined();
  });
});
