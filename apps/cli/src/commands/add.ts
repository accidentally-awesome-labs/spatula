import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { findProjectRoot } from '@spatula/core';

export interface AddResult {
  added: string[];
  invalid: string[];
  duplicates: string[];
  alreadyCrawled: string[];
}

export interface DeduplicationResult {
  valid: string[];
  invalid: string[];
  duplicates: string[];
  alreadyCrawled: string[];
}

function normaliseUrl(url: string): string {
  try { const parsed = new URL(url); return parsed.href.replace(/\/+$/, ''); }
  catch { return url; }
}

export function validateAndDedup(
  urls: string[],
  existingSeeds: string[],
  crawledUrls?: string[],
): DeduplicationResult {
  const invalid: string[] = [];
  const duplicates: string[] = [];
  const alreadyCrawled: string[] = [];
  const valid: string[] = [];
  const existingNorm = new Set(existingSeeds.map(normaliseUrl));
  const crawledNorm = new Set((crawledUrls ?? []).map(normaliseUrl));
  const seenNorm = new Set<string>();

  for (const url of urls) {
    try { new URL(url); } catch { invalid.push(url); continue; }
    const norm = normaliseUrl(url);
    if (existingNorm.has(norm)) { duplicates.push(url); continue; }
    if (crawledNorm.has(norm)) { alreadyCrawled.push(url); continue; }
    if (seenNorm.has(norm)) continue;
    seenNorm.add(norm);
    valid.push(url);
  }
  return { valid, invalid, duplicates, alreadyCrawled };
}

export async function runAddCommand(urls: string[], options?: { noHistory?: boolean }): Promise<AddResult> {
  const projectRoot = findProjectRoot(process.cwd());
  if (!projectRoot) throw new Error('No spatula.yaml found. Run `spatula init` to create a project first.');

  const yamlPath = join(projectRoot, 'spatula.yaml');
  const content = readFileSync(yamlPath, 'utf-8');
  const doc = parseYaml(content) as Record<string, unknown>;
  const existingSeeds = (doc.seeds as string[]) ?? [];

  // Crawl history lookup (graceful degradation)
  let crawledUrls: string[] = [];
  if (!options?.noHistory) {
    try {
      const { openLocalProject } = await import('../local-project.js');
      const project = await openLocalProject(process.cwd());
      try {
        crawledUrls = await project.adapter.taskRepo.findCompletedUrls();
      } finally {
        project.close();
      }
    } catch {
      // DB doesn't exist or can't be opened — skip history check
    }
  }

  const { valid, invalid, duplicates, alreadyCrawled } = validateAndDedup(urls, existingSeeds, crawledUrls);

  if (valid.length > 0) {
    doc.seeds = [...existingSeeds, ...valid];
    writeFileSync(yamlPath, stringifyYaml(doc, { lineWidth: 0 }), 'utf-8');
  }
  return { added: valid, invalid, duplicates, alreadyCrawled };
}

export function formatAddResult(result: AddResult): string {
  const lines: string[] = [];
  if (result.added.length > 0) { lines.push(`Added ${result.added.length} URL(s):`); for (const url of result.added) lines.push(`  + ${url}`); }
  if (result.duplicates.length > 0) { lines.push(`Skipped ${result.duplicates.length} duplicate(s):`); for (const url of result.duplicates) lines.push(`  ~ ${url}`); }
  if (result.alreadyCrawled.length > 0) {
    lines.push(`Skipped ${result.alreadyCrawled.length} already crawled:`);
    for (const url of result.alreadyCrawled) lines.push(`  ↻ ${url}`);
  }
  if (result.invalid.length > 0) { lines.push(`Rejected ${result.invalid.length} invalid URL(s):`); for (const url of result.invalid) lines.push(`  ✗ ${url}`); }
  if (result.added.length === 0 && result.duplicates.length === 0 && result.invalid.length === 0 && result.alreadyCrawled.length === 0) lines.push('No URLs provided.');
  return lines.join('\n');
}
