import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node-notifier', () => ({ default: { notify: vi.fn() } }));
const mockFetch = vi.fn().mockResolvedValue({ ok: true });
vi.stubGlobal('fetch', mockFetch);

import { sendDesktopNotification, sendWebhookNotification } from '../../src/notifications.js';

describe('notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CI;
    delete process.env.DOCKER;
  });

  it('desktop calls node-notifier', async () => {
    await sendDesktopNotification('Test', 'Hello');
    const notifier = (await import('node-notifier')).default;
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Test', message: 'Hello' }),
    );
  });

  it('desktop skips in CI', async () => {
    process.env.CI = 'true';
    const notifier = (await import('node-notifier')).default;
    vi.mocked(notifier.notify).mockClear();
    await sendDesktopNotification('Test', 'Hello');
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('webhook posts JSON', async () => {
    await sendWebhookNotification('https://hooks.example.com', { type: 'done', data: {} });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://hooks.example.com',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('webhook handles failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('net'));
    await expect(
      sendWebhookNotification('https://x.com', { type: 'fail', data: {} }),
    ).resolves.not.toThrow();
  });
});
