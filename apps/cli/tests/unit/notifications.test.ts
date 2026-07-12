import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn().mockResolvedValue({ ok: true });
vi.stubGlobal('fetch', mockFetch);

import { sendDesktopNotification, sendWebhookNotification } from '../../src/notifications.js';

describe('notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CI;
    delete process.env.DOCKER;
  });

  it('desktop notification degrades gracefully when no notifier is bundled', async () => {
    await expect(sendDesktopNotification('Test', 'Hello')).resolves.not.toThrow();
  });

  it('desktop skips in CI', async () => {
    process.env.CI = 'true';
    await expect(sendDesktopNotification('Test', 'Hello')).resolves.not.toThrow();
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
