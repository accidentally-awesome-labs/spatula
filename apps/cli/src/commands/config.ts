import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { findProjectRoot } from '@accidentally-awesome-labs/spatula-core';

export function getEditorCommand(): string {
  return process.env.EDITOR || process.env.VISUAL || 'vi';
}

export async function runConfigCommand(): Promise<void> {
  const projectRoot = findProjectRoot(process.cwd());
  if (!projectRoot) {
    console.error('No spatula.yaml found. Run `spatula init` to create a project first.');
    process.exit(1);
  }

  const yamlPath = join(projectRoot, 'spatula.yaml');
  const editor = getEditorCommand();
  const parts = editor.split(/\s+/);
  const cmd = parts[0];
  const args = [...parts.slice(1), yamlPath];

  console.log(`Opening ${yamlPath} in ${cmd}...`);
  const result = spawnSync(cmd, args, { stdio: 'inherit' });

  if (result.error) {
    console.error(`Failed to open editor: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`Editor exited with code ${result.status}`);
    process.exit(1);
  }
}
