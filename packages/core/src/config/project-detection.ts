import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const PROJECT_FILE = 'spatula.yaml';

export function findProjectRoot(startDir: string): string | null {
  let current = resolve(startDir);
  while (true) {
    const candidate = join(current, PROJECT_FILE);
    if (existsSync(candidate)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}
