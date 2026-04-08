import { describe, it, expect } from 'vitest';
import { buildWsUrl } from '../../../src/hooks/useWebSocket.js';

describe('buildWsUrl', () => {
  it('builds local WS URL with tenantId query param', () => {
    const url = buildWsUrl('http://localhost:3000', 'tenant-1', 'job-1');
    expect(url).toBe('ws://localhost:3000/ws/jobs/job-1/progress?tenantId=tenant-1');
  });

  it('builds authenticated WS URL with token query param', () => {
    const url = buildWsUrl('https://api.spatula.dev', 'tenant-1', 'job-1', 'tok_abc');
    expect(url).toBe('wss://api.spatula.dev/ws/jobs/job-1/progress?token=tok_abc');
  });

  it('converts https to wss', () => {
    const url = buildWsUrl('https://api.example.com', '', 'j1', 'tok');
    expect(url).toMatch(/^wss:\/\//);
  });
});
