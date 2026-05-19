import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadRateLimitsConfig,
  lookupRateLimit,
  _resetRateLimitsCacheForTests,
} from '../../../src/middleware/rate-limit-config.js';

describe('rate-limit-config loader', () => {
  let tmpDir: string;
  let envBackup: string | undefined;

  beforeEach(() => {
    envBackup = process.env.SPATULA_RATE_LIMITS_PATH;
    tmpDir = mkdtempSync(join(tmpdir(), 'spatula-rl-cfg-'));
    _resetRateLimitsCacheForTests();
  });

  afterEach(() => {
    if (envBackup === undefined) {
      delete process.env.SPATULA_RATE_LIMITS_PATH;
    } else {
      process.env.SPATULA_RATE_LIMITS_PATH = envBackup;
    }
    rmSync(tmpDir, { recursive: true, force: true });
    _resetRateLimitsCacheForTests();
  });

  function writeFixture(name: string, content: string): string {
    const path = join(tmpDir, name);
    writeFileSync(path, content, 'utf-8');
    return path;
  }

  it('loads YAML and parses default + routeGroups via SPATULA_RATE_LIMITS_PATH overlay', () => {
    const path = writeFixture(
      'rl.yaml',
      `default:
  requestsPerMinute: 100
  maxConcurrentJobs: 3

routeGroups:
  "GET /api/v1/foo":
    requestsPerMinute: 1000
  "POST /api/v1/bar":
    requestsPerMinute: 10
    maxConcurrentJobs: 1
`,
    );
    process.env.SPATULA_RATE_LIMITS_PATH = path;

    const cfg = loadRateLimitsConfig();
    expect(cfg.default.requestsPerMinute).toBe(100);
    expect(cfg.default.maxConcurrentJobs).toBe(3);
    expect(cfg.routeGroups['GET /api/v1/foo'].requestsPerMinute).toBe(1000);
    expect(cfg.routeGroups['POST /api/v1/bar'].requestsPerMinute).toBe(10);
    expect(cfg.routeGroups['POST /api/v1/bar'].maxConcurrentJobs).toBe(1);
  });

  it('caches result across subsequent calls (no re-read from disk)', () => {
    const path = writeFixture(
      'rl.yaml',
      `default:
  requestsPerMinute: 100
`,
    );
    process.env.SPATULA_RATE_LIMITS_PATH = path;

    const first = loadRateLimitsConfig();
    // Modify the file on disk — second call MUST return the cached value.
    writeFileSync(
      path,
      `default:
  requestsPerMinute: 999
`,
      'utf-8',
    );
    const second = loadRateLimitsConfig();
    expect(second).toBe(first);
    expect(second.default.requestsPerMinute).toBe(100);
  });

  it('picks up a new file after _resetRateLimitsCacheForTests', () => {
    const path = writeFixture(
      'rl.yaml',
      `default:
  requestsPerMinute: 100
`,
    );
    process.env.SPATULA_RATE_LIMITS_PATH = path;
    const first = loadRateLimitsConfig();
    expect(first.default.requestsPerMinute).toBe(100);

    writeFileSync(
      path,
      `default:
  requestsPerMinute: 250
`,
      'utf-8',
    );
    _resetRateLimitsCacheForTests();
    const second = loadRateLimitsConfig();
    expect(second.default.requestsPerMinute).toBe(250);
  });

  it('throws on malformed YAML (fail-loud at boot)', () => {
    const path = writeFixture(
      'rl.yaml',
      `default:
  requestsPerMinute: not-a-number
`,
    );
    process.env.SPATULA_RATE_LIMITS_PATH = path;
    expect(() => loadRateLimitsConfig()).toThrow();
  });

  it('lookupRateLimit returns exact-match route entry when present', () => {
    const path = writeFixture(
      'rl.yaml',
      `default:
  requestsPerMinute: 100

routeGroups:
  "GET /api/v1/jobs/:id":
    requestsPerMinute: 500
`,
    );
    process.env.SPATULA_RATE_LIMITS_PATH = path;

    const cfg = lookupRateLimit('GET', '/api/v1/jobs/:id');
    expect(cfg.requestsPerMinute).toBe(500);
  });

  it('lookupRateLimit falls back to default when no exact match', () => {
    const path = writeFixture(
      'rl.yaml',
      `default:
  requestsPerMinute: 100

routeGroups:
  "GET /api/v1/known":
    requestsPerMinute: 1000
`,
    );
    process.env.SPATULA_RATE_LIMITS_PATH = path;

    const cfg = lookupRateLimit('GET', '/api/v1/unknown-route');
    expect(cfg.requestsPerMinute).toBe(100);
  });

  it('lookupRateLimit normalizes method to upper-case', () => {
    const path = writeFixture(
      'rl.yaml',
      `default:
  requestsPerMinute: 100

routeGroups:
  "POST /api/v1/jobs":
    requestsPerMinute: 30
`,
    );
    process.env.SPATULA_RATE_LIMITS_PATH = path;

    const cfgLower = lookupRateLimit('post', '/api/v1/jobs');
    const cfgUpper = lookupRateLimit('POST', '/api/v1/jobs');
    expect(cfgLower.requestsPerMinute).toBe(30);
    expect(cfgUpper.requestsPerMinute).toBe(30);
  });
});
