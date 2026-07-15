import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  HealthCheckRegistry,
  createSystemChecks,
  createServerChecks,
  findProjectRoot,
} from '@accidentally-awesome-labs/spatula-core';
import type { CheckCategory, CheckResult } from '@accidentally-awesome-labs/spatula-core';

export function determineCategoriesFromContext(context: {
  hasEnv: boolean;
  hasProject: boolean;
}): CheckCategory[] {
  const categories: CheckCategory[] = ['system'];
  if (context.hasEnv) categories.push('server');
  if (context.hasProject) categories.push('project');
  return categories;
}

export function formatCheckResults(results: CheckResult[]): string {
  const lines: string[] = [];
  let currentCategory = '';

  for (const result of results) {
    if (result.category !== currentCategory) {
      currentCategory = result.category;
      lines.push(`\n  ${currentCategory.toUpperCase()} CHECKS`);
      lines.push('  ' + '-'.repeat(40));
    }

    const icon = result.status === 'pass' ? ' PASS' : result.status === 'warn' ? ' WARN' : ' FAIL';
    lines.push(`  ${icon}  ${result.name} — ${result.message}`);
  }

  const passed = results.filter((r) => r.status === 'pass').length;
  const warned = results.filter((r) => r.status === 'warn').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  lines.push('');
  lines.push(`  ${results.length} checks: ${passed} passed, ${warned} warnings, ${failed} failed`);

  return lines.join('\n');
}

export async function runDoctorCommand(): Promise<void> {
  const cwd = process.cwd();

  const hasEnv = existsSync(join(cwd, '.env')) || existsSync(join(cwd, '.env.local'));
  const hasProject = findProjectRoot(cwd) !== null;
  const categories = determineCategoriesFromContext({ hasEnv, hasProject });

  console.log('\nSpatula Doctor\n');
  console.log(
    `  Context: ${hasProject ? 'inside project' : 'no project'}, ${hasEnv ? '.env found' : 'no .env'}`,
  );

  const registry = new HealthCheckRegistry();
  for (const check of createSystemChecks()) registry.register(check);

  if (hasEnv) {
    for (const check of createServerChecks({})) registry.register(check);
  }

  if (categories.includes('project')) {
    const { createProjectChecks, findProjectRoot, parseProjectYamlFile } =
      await import('@accidentally-awesome-labs/spatula-core');
    const projectRoot = findProjectRoot(process.cwd());
    if (projectRoot) {
      const projectChecks = createProjectChecks({
        projectRoot,
        validateYaml: () => {
          parseProjectYamlFile(join(projectRoot, 'spatula.yaml'));
          return true;
        },
      });
      for (const check of projectChecks) {
        registry.register(check);
      }
    }
  }

  const results = await registry.runChecks(categories);
  console.log(formatCheckResults(results));

  const hasFail = results.some((r) => r.status === 'fail');
  if (hasFail) process.exitCode = 1;
}
