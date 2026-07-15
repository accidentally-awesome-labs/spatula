import { constants, accessSync, existsSync, statSync } from 'node:fs';
import { chromium } from 'playwright';
import {
  loadGlobalConfig,
  type GlobalConfig,
  type LLMProvider,
} from '@accidentally-awesome-labs/spatula-core';

export const DEFAULT_OPENROUTER_MODEL = 'deepseek/deepseek-v4-flash';
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

export interface RuntimeConfig {
  provider: LLMProvider;
  model: string;
  crawler: 'playwright' | 'firecrawl';
  openrouterApiKey?: string;
  firecrawlApiKey?: string;
  ollamaBaseUrl: string;
}

export interface PreflightIssue {
  code: string;
  message: string;
  fix: string;
}

export interface ProviderCheck {
  status: 'pass' | 'warn' | 'fail';
  message: string;
}

export function resolveRuntimeConfig(
  config: GlobalConfig | null = loadGlobalConfig(),
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  const requestedProvider = env.LLM_PROVIDER ?? config?.llm?.provider;
  const provider: LLMProvider = requestedProvider === 'ollama' ? 'ollama' : 'openrouter';
  const requestedCrawler = env.SPATULA_CRAWLER ?? config?.crawler;
  const crawler = requestedCrawler === 'firecrawl' ? 'firecrawl' : 'playwright';

  return {
    provider,
    crawler,
    model:
      env.LLM_PRIMARY_MODEL ??
      config?.llm?.model ??
      (provider === 'openrouter' ? DEFAULT_OPENROUTER_MODEL : 'llama3.1:8b-instruct-q4_0'),
    openrouterApiKey: env.OPENROUTER_API_KEY?.trim() || config?.openrouterApiKey?.trim(),
    firecrawlApiKey: env.FIRECRAWL_API_KEY?.trim() || config?.firecrawlApiKey?.trim(),
    ollamaBaseUrl: env.OLLAMA_BASE_URL ?? config?.ollamaBaseUrl ?? DEFAULT_OLLAMA_URL,
  };
}

export function chromiumInstalled(): boolean {
  try {
    const executablePath = chromium.executablePath();
    if (!existsSync(executablePath)) return false;
    accessSync(executablePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function verifyChromiumLaunch(): Promise<ProviderCheck> {
  if (!chromiumInstalled()) {
    return {
      status: 'fail',
      message: 'Playwright Chromium is not installed.',
    };
  }

  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return { status: 'pass', message: 'Playwright Chromium launched successfully.' };
  } catch (error) {
    return {
      status: 'fail',
      message: `Chromium is installed but could not launch: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export async function checkProviderConnection(
  runtime: RuntimeConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderCheck> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    if (runtime.provider === 'openrouter') {
      if (!runtime.openrouterApiKey) {
        return { status: 'fail', message: 'No OpenRouter API key is configured.' };
      }
      const base = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1';
      const response = await fetchImpl(`${base.replace(/\/$/, '')}/models`, {
        headers: { Authorization: `Bearer ${runtime.openrouterApiKey}` },
        signal: controller.signal,
      });
      if (response.ok) return { status: 'pass', message: 'OpenRouter credentials verified.' };
      if (response.status === 401 || response.status === 403) {
        return { status: 'fail', message: 'OpenRouter rejected the configured API key.' };
      }
      return {
        status: 'warn',
        message: `OpenRouter verification returned HTTP ${response.status}; the key was saved.`,
      };
    }

    const base = runtime.ollamaBaseUrl.replace(/\/$/, '');
    const response = await fetchImpl(`${base}/api/tags`, { signal: controller.signal });
    if (!response.ok) {
      return { status: 'fail', message: `Ollama returned HTTP ${response.status}.` };
    }
    const body = (await response.json().catch(() => null)) as {
      models?: Array<{ name?: string; model?: string }>;
    } | null;
    const models = body?.models ?? [];
    const configured = runtime.model;
    const available = models.some(
      (model) => model.name === configured || model.model === configured,
    );
    if (models.length > 0 && !available) {
      return {
        status: 'warn',
        message: `Ollama is reachable, but model ${configured} is not installed.`,
      };
    }
    return { status: 'pass', message: 'Ollama is reachable.' };
  } catch (error) {
    return {
      status: runtime.provider === 'openrouter' ? 'warn' : 'fail',
      message: `${runtime.provider === 'openrouter' ? 'OpenRouter' : 'Ollama'} could not be reached: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function collectPreflightIssues(
  runtime: RuntimeConfig,
  options: { requireLlm?: boolean; requireCrawler?: boolean } = {},
): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const requireLlm = options.requireLlm ?? true;
  const requireCrawler = options.requireCrawler ?? true;

  if (Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10) < 22) {
    issues.push({
      code: 'node-version',
      message: `Node.js ${process.versions.node} is unsupported; Spatula requires Node.js 22 or newer.`,
      fix: 'Install Node.js 22 LTS, then reinstall @accidentally-awesome-labs/spatula.',
    });
  }

  if (requireLlm && runtime.provider === 'openrouter' && !runtime.openrouterApiKey) {
    issues.push({
      code: 'openrouter-key',
      message: 'Structured extraction needs an OpenRouter API key.',
      fix: 'Run `spatula setup`, or set OPENROUTER_API_KEY.',
    });
  }

  if (requireCrawler && runtime.crawler === 'playwright' && !chromiumInstalled()) {
    issues.push({
      code: 'playwright-browser',
      message: 'The Playwright Chromium browser is not installed.',
      fix: 'Run `spatula setup` and approve the browser download.',
    });
  }

  if (requireCrawler && runtime.crawler === 'firecrawl' && !runtime.firecrawlApiKey) {
    issues.push({
      code: 'firecrawl-key',
      message: 'The Firecrawl crawler needs an API key.',
      fix: 'Run `spatula setup`, or set FIRECRAWL_API_KEY.',
    });
  }

  return issues;
}

export function formatPreflightIssues(issues: PreflightIssue[]): string {
  return issues.map((issue) => `  - ${issue.message}\n    Fix: ${issue.fix}`).join('\n');
}

export function configPermissionsArePrivate(configPath: string): boolean {
  if (process.platform === 'win32' || !existsSync(configPath)) return true;
  try {
    return (statSync(configPath).mode & 0o077) === 0;
  } catch {
    return false;
  }
}
