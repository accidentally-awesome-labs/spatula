import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkProviderConnection,
  collectPreflightIssues,
  configPermissionsArePrivate,
  resolveRuntimeConfig,
} from '../../src/runtime-preflight.js';

describe('runtime preflight', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('defaults new users to OpenRouter and Playwright', () => {
    delete process.env.LLM_PROVIDER;
    delete process.env.SPATULA_CRAWLER;
    delete process.env.OPENROUTER_API_KEY;
    const runtime = resolveRuntimeConfig({ version: 1 });
    expect(runtime.provider).toBe('openrouter');
    expect(runtime.crawler).toBe('playwright');
    expect(runtime.model).toBe('deepseek/deepseek-v4-flash');
  });

  it('gives environment variables precedence over saved secrets and preferences', () => {
    process.env.LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'env-key';
    process.env.SPATULA_CRAWLER = 'firecrawl';
    process.env.FIRECRAWL_API_KEY = 'env-firecrawl';
    const runtime = resolveRuntimeConfig({
      version: 1,
      openrouterApiKey: 'saved-key',
      llm: { provider: 'ollama' },
      crawler: 'playwright',
    });
    expect(runtime.provider).toBe('openrouter');
    expect(runtime.openrouterApiKey).toBe('env-key');
    expect(runtime.crawler).toBe('firecrawl');
    expect(runtime.firecrawlApiKey).toBe('env-firecrawl');
  });

  it('returns an actionable issue when OpenRouter is not configured', () => {
    delete process.env.OPENROUTER_API_KEY;
    const runtime = resolveRuntimeConfig({ version: 1, llm: { provider: 'openrouter' } });
    const issues = collectPreflightIssues(runtime, { requireCrawler: false });
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'openrouter-key',
        fix: expect.stringContaining('spatula setup'),
      }),
    );
  });

  it('validates OpenRouter credentials with the cost-free models endpoint', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const runtime = resolveRuntimeConfig({
      version: 1,
      openrouterApiKey: 'sk-test',
      llm: { provider: 'openrouter' },
    });
    const result = await checkProviderConnection(runtime, fetchImpl as typeof fetch);
    expect(result.status).toBe('pass');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/models',
      expect.objectContaining({ headers: { Authorization: 'Bearer sk-test' } }),
    );
  });

  it('detects an overly permissive config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spatula-perms-'));
    const file = join(dir, 'config.yaml');
    writeFileSync(file, 'version: 1\n');
    chmodSync(file, 0o644);
    expect(configPermissionsArePrivate(file)).toBe(false);
    chmodSync(file, 0o600);
    expect(configPermissionsArePrivate(file)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
