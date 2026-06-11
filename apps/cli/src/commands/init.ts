/**
 * `spatula init [url]` — initialise a new project directory.
 *
 * Creates:
 *  - ~/.spatula/config.yaml  (global config, if missing)
 *  - spatula.yaml            (project config, with seed URL / depth / limit)
 *  - .spatula/               (working directories)
 *  - .gitignore entry        (adds .spatula/ if a .gitignore exists)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_FILE = 'spatula.yaml';
const SPATULA_DIR = '.spatula';
const GITIGNORE_FILE = '.gitignore';
const GITIGNORE_ENTRY = '.spatula/';

const SUBDIRS = ['pages', 'exports', 'cache/robots', 'logs'] as const;

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface InitOptions {
  url?: string;
  depth?: number;
  limit?: number;
  /** Directory to initialise (defaults to process.cwd()). */
  cwd?: string;
}

export interface InitResult {
  createdYaml: boolean;
  createdGlobalConfig: boolean;
  spatulaDir: string;
  gitignoreUpdated: boolean;
}

// ---------------------------------------------------------------------------
// Command runner
// ---------------------------------------------------------------------------

export async function runInitCommand(options: InitOptions): Promise<InitResult> {
  const cwd = options.cwd ?? process.cwd();
  const depth = options.depth ?? 2;
  const limit = options.limit ?? 1000;

  const result: InitResult = {
    createdYaml: false,
    createdGlobalConfig: false,
    spatulaDir: join(cwd, SPATULA_DIR),
    gitignoreUpdated: false,
  };

  // 1. Ensure global config exists
  result.createdGlobalConfig = ensureGlobalConfig();

  // 2. Create spatula.yaml (only if missing)
  result.createdYaml = createProjectYaml(cwd, { url: options.url, depth, limit });

  // 3. Create .spatula/ directory structure
  await createSpatulaDir(cwd);

  // 4. Update .gitignore
  result.gitignoreUpdated = updateGitignore(cwd);

  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Ensure ~/.spatula/config.yaml exists.
 * Returns true if it was newly created, false if it already existed.
 */
export function ensureGlobalConfig(configPath?: string): boolean {
  const spatulaHome = process.env.SPATULA_HOME ?? join(homedir(), '.spatula');
  const path = configPath ?? join(spatulaHome, 'config.yaml');

  if (existsSync(path)) return false;

  const dir = join(path, '..');
  mkdirSync(dir, { recursive: true });

  const content = [
    '# Spatula global configuration',
    '# See https://spatula.dev/docs/config for all options',
    'version: 1',
    '',
    '# LLM provider (openrouter or ollama)',
    '# llm:',
    '#   provider: openrouter',
    '#   model: deepseek/deepseek-v4-pro',
    '',
    '# API keys (can also be set via env vars)',
    '# openrouterApiKey: sk-or-...',
    '',
  ].join('\n');

  writeFileSync(path, content, 'utf-8');
  return true;
}

/**
 * Create the spatula.yaml project config file.
 * Returns false (and does nothing) if it already exists.
 */
export function createProjectYaml(
  cwd: string,
  options: { url?: string; depth: number; limit: number },
): boolean {
  const filePath = join(cwd, PROJECT_FILE);
  if (existsSync(filePath)) return false;

  let validatedUrl: string | undefined;
  if (options.url) {
    try {
      validatedUrl = new URL(options.url).href;
    } catch {
      throw new Error(`Invalid seed URL: ${options.url}`);
    }
  }

  const seedLine = validatedUrl
    ? `  - ${validatedUrl}`
    : '  - https://example.com  # Replace with your seed URL';

  const content = [
    '# Spatula project configuration',
    '# Run `spatula run` to start crawling',
    '',
    `depth: ${options.depth}`,
    `limit: ${options.limit}`,
    '',
    'seeds:',
    seedLine,
    '',
    '# Describe the data you want to extract',
    '# fields:',
    '#   - name: string',
    '#   - price: currency',
    '#   - description: string',
    '',
  ].join('\n');

  writeFileSync(filePath, content, 'utf-8');
  return true;
}

/**
 * Create the .spatula/ working directory and standard subdirectories.
 */
export async function createSpatulaDir(cwd: string): Promise<void> {
  for (const subdir of SUBDIRS) {
    await mkdir(join(cwd, SPATULA_DIR, subdir), { recursive: true });
  }
}

/**
 * Append `.spatula/` to .gitignore if the file exists and the entry is absent.
 * Returns true if the file was modified.
 */
export function updateGitignore(cwd: string): boolean {
  const gitignorePath = join(cwd, GITIGNORE_FILE);
  if (!existsSync(gitignorePath)) return false;

  const content = readFileSync(gitignorePath, 'utf-8');
  const lines = content.split('\n');

  // Check if any existing line already covers .spatula/
  const alreadyIgnored = lines.some((line) => {
    const trimmed = line.trim();
    return trimmed === GITIGNORE_ENTRY || trimmed === GITIGNORE_ENTRY.slice(0, -1); // '.spatula' or '.spatula/'
  });

  if (alreadyIgnored) return false;

  // Append (with leading newline if the file doesn't already end with one)
  const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
  writeFileSync(gitignorePath, `${content}${separator}${GITIGNORE_ENTRY}\n`, 'utf-8');
  return true;
}

// ---------------------------------------------------------------------------
// Formatted output
// ---------------------------------------------------------------------------

export function formatInitResult(result: InitResult, cwd: string): string {
  const lines: string[] = [];
  lines.push('Spatula project initialised.');
  lines.push('');

  if (result.createdYaml) {
    lines.push(`  Created  ${join(cwd, PROJECT_FILE)}`);
  } else {
    lines.push(`  Skipped  ${join(cwd, PROJECT_FILE)} (already exists)`);
  }

  lines.push(`  Created  ${result.spatulaDir}/`);

  if (result.createdGlobalConfig) {
    lines.push(`  Created  global config at ~/.spatula/config.yaml`);
  }

  if (result.gitignoreUpdated) {
    lines.push(`  Updated  ${join(cwd, GITIGNORE_FILE)} (added .spatula/)`);
  }

  lines.push('');
  lines.push('Next step: edit spatula.yaml, then run `spatula run`.');
  return lines.join('\n');
}
