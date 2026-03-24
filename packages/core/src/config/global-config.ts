// packages/core/src/config/global-config.ts
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
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
