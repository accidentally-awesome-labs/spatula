// packages/core/src/config/global-config.ts
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { ValidationError } from '@spatula/shared';
import { GlobalConfigSchema } from './types.js';
import type { GlobalConfig } from './types.js';

/**
 * Get the path to the global config file.
 * Respects SPATULA_HOME env var, defaults to ~/.spatula/config.yaml.
 */
export function getGlobalConfigPath(): string {
  const home = process.env.SPATULA_HOME ?? join(homedir(), '.spatula');
  return join(home, 'config.yaml');
}

/**
 * Load global config from ~/.spatula/config.yaml.
 * Returns null if the file does not exist.
 * Throws ValidationError on invalid content.
 */
export function loadGlobalConfig(configPath?: string): GlobalConfig | null {
  const path = configPath ?? getGlobalConfigPath();

  if (!existsSync(path)) {
    return null;
  }

  const content = readFileSync(path, 'utf-8');

  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (err) {
    throw new ValidationError(`Invalid YAML in global config: ${(err as Error).message}`);
  }

  if (raw === null || raw === undefined) {
    return { version: 1 };
  }

  const result = GlobalConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new ValidationError(`Invalid global config: ${issues}`);
  }

  return result.data;
}

export interface SaveGlobalConfigOptions {
  merge?: boolean;
}

/**
 * Save global config to ~/.spatula/config.yaml (or the given path).
 * Creates the directory if it does not exist.
 * When merge is true, deep-merges with existing config.
 */
export function saveGlobalConfig(
  config: GlobalConfig,
  configPath?: string,
  options?: SaveGlobalConfigOptions,
): void {
  const path = configPath ?? getGlobalConfigPath();
  const dir = dirname(path);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  let toWrite = config;
  if (options?.merge) {
    const existing = loadGlobalConfig(path);
    if (existing) {
      toWrite = { ...existing, ...config };
      // Deep-merge remotes specifically
      if (existing.remotes || config.remotes) {
        toWrite.remotes = { ...existing.remotes, ...config.remotes };
      }
    }
  }

  writeFileSync(path, stringifyYaml(toWrite, { lineWidth: 0 }), 'utf-8');
}
