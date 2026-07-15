import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  getGlobalConfigPath,
  loadGlobalConfig,
  saveGlobalConfig,
  type GlobalConfig,
} from '@accidentally-awesome-labs/spatula-core';
import type { Readable, Writable } from 'node:stream';
import {
  checkProviderConnection,
  chromiumInstalled,
  DEFAULT_OLLAMA_URL,
  DEFAULT_OPENROUTER_MODEL,
  resolveRuntimeConfig,
  verifyChromiumLaunch,
  type ProviderCheck,
} from '../runtime-preflight.js';
import {
  processPromptIO,
  promptConfirm,
  promptSecret,
  promptText,
  type PromptIO,
} from '../lib/prompts.js';

export interface SetupAnswers {
  provider: 'openrouter' | 'ollama';
  openrouterApiKey?: string;
  ollamaBaseUrl?: string;
  firecrawlApiKey?: string;
  model?: string;
  crawler: 'playwright' | 'firecrawl';
}

export interface SetupCommandOptions {
  input?: Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => void };
  output?: Writable & { isTTY?: boolean };
  browser?: 'prompt' | 'install' | 'skip';
  verifyProvider?: boolean;
  fetchImpl?: typeof fetch;
}

export interface SetupResult {
  configPath: string;
  provider: ProviderCheck;
  browser: ProviderCheck | null;
}

export function buildGlobalConfig(answers: SetupAnswers): GlobalConfig {
  const config: GlobalConfig = { version: 1 };
  if (answers.provider === 'openrouter' && answers.openrouterApiKey) {
    config.openrouterApiKey = answers.openrouterApiKey;
  }
  if (answers.ollamaBaseUrl) config.ollamaBaseUrl = answers.ollamaBaseUrl;
  if (answers.firecrawlApiKey) config.firecrawlApiKey = answers.firecrawlApiKey;
  config.llm = { provider: answers.provider };
  if (answers.model) config.llm.model = answers.model;
  config.crawler = answers.crawler;
  return config;
}

function writeLine(io: PromptIO, text = ''): void {
  io.output.write(`${text}\n`);
}

async function promptChoice<T extends string>(
  io: PromptIO,
  question: string,
  choices: readonly T[],
  defaultValue: T,
): Promise<T> {
  while (true) {
    const answer = (await promptText(`${question} [${defaultValue}]: `, io)).toLowerCase();
    if (!answer) return defaultValue;
    if (choices.includes(answer as T)) return answer as T;
    writeLine(io, `  Choose one of: ${choices.join(', ')}`);
  }
}

export function getPlaywrightCliPath(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('playwright/package.json')), 'cli.js');
}

export async function installPlaywrightChromium(io: PromptIO = processPromptIO): Promise<void> {
  writeLine(io, '  Downloading Playwright Chromium…');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [getPlaywrightCliPath(), 'install', 'chromium'], {
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Chromium installation ${signal ? `was interrupted (${signal})` : `failed (exit ${code})`}.`,
        ),
      );
    });
  });
}

export async function runSetupCommand(options: SetupCommandOptions = {}): Promise<SetupResult> {
  const io: PromptIO = {
    input: options.input ?? processPromptIO.input,
    output: options.output ?? processPromptIO.output,
  };
  const configPath = getGlobalConfigPath();
  let existing: GlobalConfig | null = null;
  let configWarning: string | null = null;
  try {
    existing = loadGlobalConfig();
  } catch (error) {
    configWarning = error instanceof Error ? error.message : String(error);
  }

  writeLine(io);
  writeLine(io, '  Spatula Setup');
  writeLine(io, `  ${'-'.repeat(48)}`);
  writeLine(io, existing ? `  Updating ${configPath}` : `  Creating ${configPath}`);
  if (configWarning) {
    writeLine(io, `  Existing configuration is invalid and will be replaced: ${configWarning}`);
  }
  writeLine(io, '  Environment variables override saved settings.');
  writeLine(io);

  const defaultProvider = existing?.llm?.provider ?? 'openrouter';
  const provider = await promptChoice(
    io,
    '  LLM provider (openrouter/ollama)',
    ['openrouter', 'ollama'] as const,
    defaultProvider,
  );

  const answers: SetupAnswers = {
    provider,
    crawler: existing?.crawler ?? 'playwright',
  };

  if (provider === 'openrouter') {
    const hasEnvironmentKey = Boolean(process.env.OPENROUTER_API_KEY);
    const hasSavedKey = Boolean(existing?.openrouterApiKey);
    const keyHint = hasEnvironmentKey
      ? ' (environment key already set; Enter to keep using it)'
      : hasSavedKey
        ? ' (Enter to keep saved key)'
        : '';
    const key = await promptSecret(`  OpenRouter API key${keyHint}: `, io);
    answers.openrouterApiKey = key || existing?.openrouterApiKey;
  } else {
    const defaultUrl = existing?.ollamaBaseUrl ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_URL;
    const url = await promptText(`  Ollama URL [${defaultUrl}]: `, io);
    try {
      answers.ollamaBaseUrl = new URL(url || defaultUrl).href.replace(/\/$/, '');
    } catch {
      throw new Error(`Invalid Ollama URL: ${url}`);
    }
  }

  const defaultModel =
    existing?.llm?.model ??
    (provider === 'openrouter' ? DEFAULT_OPENROUTER_MODEL : 'llama3.1:8b-instruct-q4_0');
  const model = await promptText(`  Default model [${defaultModel}]: `, io);
  answers.model = model || defaultModel;

  answers.crawler = await promptChoice(
    io,
    '  Crawler (playwright/firecrawl)',
    ['playwright', 'firecrawl'] as const,
    existing?.crawler ?? 'playwright',
  );

  if (answers.crawler === 'firecrawl') {
    const hasEnvironmentKey = Boolean(process.env.FIRECRAWL_API_KEY);
    const hasSavedKey = Boolean(existing?.firecrawlApiKey);
    const keyHint = hasEnvironmentKey
      ? ' (environment key already set; Enter to keep using it)'
      : hasSavedKey
        ? ' (Enter to keep saved key)'
        : '';
    const key = await promptSecret(`  Firecrawl API key${keyHint}: `, io);
    answers.firecrawlApiKey = key || existing?.firecrawlApiKey;
  }

  const config = buildGlobalConfig(answers);
  const merged: GlobalConfig = {
    ...existing,
    ...config,
    llm: { ...existing?.llm, ...config.llm },
  };
  saveGlobalConfig(merged, configPath);
  writeLine(io);
  writeLine(io, `  Saved protected configuration to ${configPath}`);

  let browserCheck: ProviderCheck | null = null;
  if (answers.crawler === 'playwright') {
    const browserMode = options.browser ?? 'prompt';
    let shouldInstall = browserMode === 'install';
    if (!chromiumInstalled() && browserMode === 'prompt') {
      shouldInstall = await promptConfirm(
        '  Playwright needs a Chromium download (roughly 200 MB). Install it now?',
        true,
        io,
      );
    }
    if (!chromiumInstalled() && shouldInstall) {
      await installPlaywrightChromium(io);
    }
    browserCheck = await verifyChromiumLaunch();
    writeLine(io, `  ${browserCheck.status.toUpperCase()}  ${browserCheck.message}`);
    if (browserCheck.status === 'fail') {
      writeLine(io, '        Fix: run `spatula setup` and approve the browser download.');
    }
  }

  const runtime = resolveRuntimeConfig(merged);
  const providerCheck =
    options.verifyProvider === false
      ? { status: 'pass' as const, message: `${provider} configuration saved.` }
      : await checkProviderConnection(runtime, options.fetchImpl);
  writeLine(io, `  ${providerCheck.status.toUpperCase()}  ${providerCheck.message}`);
  if (providerCheck.status === 'fail') {
    writeLine(
      io,
      provider === 'openrouter'
        ? '        Fix: run `spatula setup` and enter a valid OpenRouter key.'
        : `        Fix: start Ollama and install the model with \`ollama pull ${runtime.model}\`.`,
    );
  }

  writeLine(io);
  if (providerCheck.status !== 'fail' && browserCheck?.status !== 'fail') {
    writeLine(io, '  Setup complete. Run `spatula` to create your first crawl.');
  } else {
    process.exitCode = 1;
  }

  return { configPath, provider: providerCheck, browser: browserCheck };
}
