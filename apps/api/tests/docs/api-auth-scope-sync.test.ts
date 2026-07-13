/**
 * CI gate: docs/api-auth.md scope table must match AUTH_SCOPES in code.
 *
 * This test is the single source-of-truth enforcement for auth scope docs:
 * "doc table matches code constant". It fails if:
 *   - A scope is added to AUTH_SCOPES but not to the doc table
 *   - A scope is in the doc table but removed from AUTH_SCOPES
 *   - The doc table markers (SCOPE_TABLE_START/SCOPE_TABLE_END) are missing
 *
 * The doc table is bounded by HTML comment markers:
 *   <!-- SCOPE_TABLE_START -->
 *   <!-- SCOPE_TABLE_END -->
 *
 * Each table row has the format: | `scope:name` | ... | ... |
 * The scope name is extracted from the first column by stripping backticks.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUTH_SCOPES } from '@spatula/shared';

// Resolve docs/api-auth.md relative to the monorepo root.
// apps/api/ is two levels below the root.
const MONOREPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const DOC_PATH = join(MONOREPO_ROOT, 'docs', 'api-auth.md');

function extractDocScopes(docContent: string): string[] {
  // Find the bounded region between the markers
  const startMarker = '<!-- SCOPE_TABLE_START -->';
  const endMarker = '<!-- SCOPE_TABLE_END -->';

  const startIdx = docContent.indexOf(startMarker);
  const endIdx = docContent.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1) {
    throw new Error(
      `docs/api-auth.md is missing scope table markers.\n` +
        `Expected:\n  ${startMarker}\n  ...\n  ${endMarker}`,
    );
  }
  if (endIdx <= startIdx) {
    throw new Error(
      `docs/api-auth.md: SCOPE_TABLE_END marker appears before SCOPE_TABLE_START marker.`,
    );
  }

  const tableRegion = docContent.slice(startIdx + startMarker.length, endIdx);

  // Parse table rows: lines that start with `|` and contain a backtick-quoted scope name
  // Header row and separator row are skipped (they don't match the scope pattern).
  // Scope pattern: first column is | `scope:name` | or | `admin` |
  const scopeNames: string[] = [];
  for (const line of tableRegion.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;

    // Split into columns, trim each
    const cols = trimmed
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean);

    if (cols.length < 1) continue;

    // First column: extract content between backticks
    const firstCol = cols[0];
    const match = firstCol.match(/^`([^`]+)`$/);
    if (!match) continue; // header row, separator row, or non-scope row

    scopeNames.push(match[1]);
  }

  return scopeNames;
}

describe('docs/api-auth.md scope table sync gate', () => {
  it('docs/api-auth.md exists', () => {
    expect(() => readFileSync(DOC_PATH, 'utf8')).not.toThrow();
  });

  it('scope table markers are present', () => {
    const content = readFileSync(DOC_PATH, 'utf8');
    expect(content).toContain('<!-- SCOPE_TABLE_START -->');
    expect(content).toContain('<!-- SCOPE_TABLE_END -->');
  });

  it('doc scope table matches AUTH_SCOPES exactly (no extra, no missing)', () => {
    const content = readFileSync(DOC_PATH, 'utf8');
    const docScopes = extractDocScopes(content);
    const codeScopes = [...AUTH_SCOPES]; // tuple → mutable array

    // Both sorted for stable comparison
    const sortedDocScopes = [...docScopes].sort();
    const sortedCodeScopes = [...codeScopes].sort();

    const inDocNotCode = sortedDocScopes.filter((s) => !codeScopes.includes(s as any));
    const inCodeNotDoc = sortedCodeScopes.filter((s) => !docScopes.includes(s));

    expect(
      inDocNotCode,
      `Scopes in docs/api-auth.md but NOT in AUTH_SCOPES:\n  ${inDocNotCode.join(', ')}\n\nUpdate AUTH_SCOPES in packages/shared/src/auth/types.ts or remove from doc.`,
    ).toHaveLength(0);

    expect(
      inCodeNotDoc,
      `Scopes in AUTH_SCOPES but NOT in docs/api-auth.md scope table:\n  ${inCodeNotDoc.join(', ')}\n\nAdd them to the <!-- SCOPE_TABLE_START --> ... <!-- SCOPE_TABLE_END --> block in docs/api-auth.md.`,
    ).toHaveLength(0);

    expect(sortedDocScopes).toEqual(sortedCodeScopes);
  });

  it('doc has all 9 AUTH_SCOPES values present in the table', () => {
    const content = readFileSync(DOC_PATH, 'utf8');
    const docScopes = extractDocScopes(content);
    expect(docScopes).toHaveLength(AUTH_SCOPES.length);
    for (const scope of AUTH_SCOPES) {
      expect(docScopes, `Missing scope in doc table: ${scope}`).toContain(scope);
    }
  });
});
