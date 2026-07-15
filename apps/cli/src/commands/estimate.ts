import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  findProjectRoot,
  parseProjectYaml,
  yamlToJobConfig,
  loadGlobalConfig,
  estimateCost,
} from '@accidentally-awesome-labs/spatula-core';
import type { CostEstimate } from '@accidentally-awesome-labs/spatula-core';
import { slugifyPath } from '../local-project.js';

export function formatCostEstimate(estimate: CostEstimate): string {
  const lines: string[] = [];
  lines.push('\n  Cost Estimate');
  lines.push('  ' + '-'.repeat(60));
  lines.push(`  Estimated pages:     ${estimate.estimatedPages}`);
  lines.push(`  Total tokens:        ${estimate.totalTokens.toLocaleString()}`);
  lines.push(`  Estimated cost:      $${estimate.totalCostUsd.toFixed(3)}`);
  lines.push(`  Confidence:          ${estimate.confidence}`);
  lines.push('\n  Breakdown');
  lines.push('  ' + '-'.repeat(60));
  lines.push(
    `  ${'Task'.padEnd(22)} ${'Model'.padEnd(18)} ${'Calls'.padEnd(8)} ${'Cost'.padEnd(8)}`,
  );
  lines.push('  ' + '-'.repeat(60));
  for (const entry of estimate.llmCallBreakdown) {
    const modelName = entry.model.split('/').at(-1) ?? entry.model;
    const model = modelName.length > 18 ? `${modelName.slice(0, 15)}...` : modelName;
    lines.push(
      `  ${entry.purpose.padEnd(22)} ${model.padEnd(18)} ${String(entry.calls).padEnd(8)} $${entry.costUsd.toFixed(3)}`,
    );
  }
  if (estimate.warnings.length > 0) {
    lines.push('\n  Warnings');
    for (const w of estimate.warnings) lines.push(`  ! ${w}`);
  }
  return lines.join('\n');
}

export async function runEstimateCommand(): Promise<void> {
  const projectRoot = findProjectRoot(process.cwd());
  if (!projectRoot) {
    console.error('No spatula.yaml found. Run `spatula init` to create a project first.');
    process.exit(1);
  }
  const yamlPath = join(projectRoot, 'spatula.yaml');
  const yamlContent = readFileSync(yamlPath, 'utf-8');
  const projectYaml = parseProjectYaml(yamlContent);
  const globalConfig = loadGlobalConfig();
  const projectId = slugifyPath(projectRoot);
  const jobConfig = yamlToJobConfig(projectYaml, {
    tenantId: projectId,
    projectId,
    projectRoot,
    globalConfig,
  });
  const estimate = estimateCost(jobConfig);
  console.log(formatCostEstimate(estimate));
}
