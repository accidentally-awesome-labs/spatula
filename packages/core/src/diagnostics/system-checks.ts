import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { HealthCheck } from './health-check.js';

export function createSystemChecks(cwd = process.cwd()): HealthCheck[] {
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
        try {
          const raw = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
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

        if (process.env.OPENROUTER_API_KEY) {
          return { status: 'pass', message: 'OpenRouter API key configured' };
        }

        return { status: 'warn', message: 'No LLM provider configured (crawl-only mode)' };
      },
    },
    {
      name: 'playwright',
      category: 'system',
      async run() {
        try {
          execFileSync('npx', ['playwright', '--version'], { stdio: 'pipe', timeout: 10000 });
          return { status: 'pass', message: 'Playwright browsers installed' };
        } catch {
          return {
            status: 'warn',
            message: 'Playwright not installed (run: npx playwright install)',
          };
        }
      },
    },
    {
      name: 'env-file',
      category: 'system',
      async run() {
        if (existsSync(join(cwd, '.env')) || existsSync(join(cwd, '.env.local'))) {
          return { status: 'pass', message: '.env file found' };
        }
        return { status: 'warn', message: 'No .env file found — copy .env.example to .env' };
      },
    },
  ];
}
