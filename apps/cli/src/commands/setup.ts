import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { stringify as stringifyYaml } from 'yaml';
import { getGlobalConfigPath, loadGlobalConfig } from '@spatula/core';
import type { GlobalConfig } from '@spatula/core';

export interface SetupAnswers {
  provider: 'openrouter' | 'ollama';
  openrouterApiKey?: string;
  ollamaBaseUrl?: string;
  firecrawlApiKey?: string;
  model?: string;
  crawler: 'playwright' | 'firecrawl';
}

export function buildGlobalConfig(answers: SetupAnswers): GlobalConfig {
  const config: GlobalConfig = { version: 1 };
  if (answers.provider === 'openrouter' && answers.openrouterApiKey)
    config.openrouterApiKey = answers.openrouterApiKey;
  if (answers.firecrawlApiKey) config.firecrawlApiKey = answers.firecrawlApiKey;
  config.llm = { provider: answers.provider };
  if (answers.model) config.llm.model = answers.model;
  config.crawler = answers.crawler;
  return config;
}

async function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

export async function runSetupCommand(): Promise<void> {
  const configPath = getGlobalConfigPath();
  const existing = loadGlobalConfig();
  console.log('\n  Spatula Setup');
  console.log('  ' + '-'.repeat(40));
  console.log(existing ? `  Editing: ${configPath}\n` : `  Creating: ${configPath}\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const defaultProvider = existing?.llm?.provider ?? 'openrouter';
    const provider = await prompt(rl, `  LLM provider (openrouter/ollama) [${defaultProvider}]: `);
    const selectedProvider = (provider || defaultProvider) as 'openrouter' | 'ollama';
    const answers: SetupAnswers = { provider: selectedProvider, crawler: 'playwright' };

    if (selectedProvider === 'openrouter') {
      const defaultKey = existing?.openrouterApiKey ? '(keep existing)' : '';
      const key = await prompt(rl, `  OpenRouter API key ${defaultKey}: `);
      answers.openrouterApiKey = key || existing?.openrouterApiKey;
    }
    // Note: Ollama base URL is configured via OLLAMA_BASE_URL env var, not global config

    const defaultModel = existing?.llm?.model ?? '';
    const model = await prompt(rl, `  Default LLM model [${defaultModel || 'auto'}]: `);
    answers.model = model || defaultModel || undefined;

    const defaultCrawler = existing?.crawler ?? 'playwright';
    const crawler = await prompt(
      rl,
      `  Default crawler (playwright/firecrawl) [${defaultCrawler}]: `,
    );
    answers.crawler = (crawler || defaultCrawler) as 'playwright' | 'firecrawl';

    const firecrawlKey = await prompt(rl, `  Firecrawl API key (optional): `);
    if (firecrawlKey) answers.firecrawlApiKey = firecrawlKey;

    const config = buildGlobalConfig(answers);
    const merged = existing ? { ...existing, ...config } : config;
    const dir = dirname(configPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, stringifyYaml(merged, { lineWidth: 0 }), 'utf-8');
    console.log(`\n  Config saved to ${configPath}`);
  } finally {
    rl.close();
  }
}
