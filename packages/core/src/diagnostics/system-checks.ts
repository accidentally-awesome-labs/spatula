import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { chromium } from 'playwright';
import type { HealthCheck } from './health-check.js';
import { getGlobalConfigPath, loadGlobalConfig } from '../config/global-config.js';

export function createSystemChecks(_cwd = process.cwd()): HealthCheck[] {
  return [
    {
      name: 'node-version',
      category: 'system',
      async run() {
        const major = parseInt(process.versions.node.split('.')[0], 10);
        if (major >= 22) {
          return { status: 'pass', message: `Node.js v${process.versions.node}` };
        }
        return { status: 'fail', message: `Node.js v${process.versions.node} — v22+ required` };
      },
    },
    {
      name: 'docker',
      category: 'system',
      async run() {
        try {
          execFileSync('docker', ['info'], { stdio: 'pipe', timeout: 5000 });
          return { status: 'pass', message: 'Docker is available' };
        } catch {
          return { status: 'warn', message: 'Docker not available (optional for local dev)' };
        }
      },
    },
    {
      name: 'llm-provider',
      category: 'system',
      async run() {
        let config: ReturnType<typeof loadGlobalConfig> = null;
        try {
          config = loadGlobalConfig();
        } catch (error) {
          return {
            status: 'fail',
            message: `Saved configuration is invalid: ${(error as Error).message}. Fix: run \`spatula setup\`.`,
          };
        }
        const requestedProvider = process.env.LLM_PROVIDER ?? config?.llm?.provider;
        const provider = requestedProvider === 'ollama' ? 'ollama' : 'openrouter';

        if (provider === 'openrouter') {
          if (process.env.OPENROUTER_API_KEY || config?.openrouterApiKey) {
            return { status: 'pass', message: 'OpenRouter API key configured' };
          }
          return {
            status: 'fail',
            message: 'No OpenRouter API key configured. Fix: run `spatula setup`.',
          };
        }

        try {
          const raw =
            process.env.OLLAMA_BASE_URL ?? config?.ollamaBaseUrl ?? 'http://localhost:11434';
          const parsed = new URL(raw);
          if (!['http:', 'https:'].includes(parsed.protocol)) {
            return {
              status: 'warn',
              message: `Invalid OLLAMA_BASE_URL scheme: ${parsed.protocol}`,
            };
          }
          const res = await fetch(`${parsed.origin}/api/tags`, {
            signal: AbortSignal.timeout(3000),
          });
          if (res.ok) return { status: 'pass', message: 'Ollama is reachable' };
        } catch {
          /* ignore */
        }
        return {
          status: 'fail',
          message: 'Ollama is not reachable. Fix: start Ollama, or run `spatula setup`.',
        };
      },
    },
    {
      name: 'crawler',
      category: 'system',
      async run() {
        let config: ReturnType<typeof loadGlobalConfig> = null;
        try {
          config = loadGlobalConfig();
        } catch {
          // The dedicated provider/config check reports invalid YAML.
        }
        const selected = process.env.SPATULA_CRAWLER ?? config?.crawler ?? 'playwright';
        if (selected === 'firecrawl') {
          if (process.env.FIRECRAWL_API_KEY || config?.firecrawlApiKey) {
            return { status: 'pass', message: 'Firecrawl API key configured' };
          }
          return {
            status: 'fail',
            message: 'Firecrawl API key is missing. Fix: run `spatula setup`.',
          };
        }

        try {
          const executablePath = chromium.executablePath();
          if (existsSync(executablePath)) {
            const browser = await chromium.launch({ headless: true });
            await browser.close();
            return { status: 'pass', message: 'Playwright Chromium launches successfully' };
          }
        } catch {
          /* fall through to warning */
        }

        return {
          status: 'fail',
          message: 'Playwright Chromium is unavailable. Fix: run `spatula setup`.',
        };
      },
    },
    {
      name: 'config-permissions',
      category: 'system',
      async run() {
        const path = getGlobalConfigPath();
        if (!existsSync(path)) {
          return { status: 'warn', message: 'No saved config yet. Fix: run `spatula setup`.' };
        }
        if (process.platform === 'win32') {
          return { status: 'pass', message: 'Config exists (permission check unavailable)' };
        }
        try {
          const mode = statSync(path).mode & 0o777;
          if ((mode & 0o077) === 0) {
            return { status: 'pass', message: 'Saved config is readable only by its owner' };
          }
          return {
            status: 'fail',
            message: `Config permissions are ${mode.toString(8)}. Fix: run \`chmod 600 "${path}"\`.`,
          };
        } catch (error) {
          return {
            status: 'warn',
            message: `Could not inspect config permissions: ${String(error)}`,
          };
        }
      },
    },
  ];
}
