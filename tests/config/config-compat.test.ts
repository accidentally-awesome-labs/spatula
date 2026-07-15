/**
 * Config compatibility test.
 *
 * Verifies that a v1.0 spatula.yaml fixture can be parsed by the v1.1 runtime
 * (parseProjectYamlFile from @accidentally-awesome-labs/spatula-core) without throwing.
 *
 * This test is pure in-process — no DB, no HTTP required.
 * It should run on every PR in addition to the on-release/nightly cadence.
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';

import { parseProjectYamlFile } from '@accidentally-awesome-labs/spatula-core';

const FIXTURE_PATH = resolve(__dirname, 'fixtures/v1.0-spatula.yaml');

describe('v1.0 spatula.yaml config compatibility', () => {
  it('parses a v1.0 spatula.yaml fixture on the v1.1 runtime without throwing', () => {
    // Should not throw — if the schema is forward-compatible, this succeeds
    let parsed: ReturnType<typeof parseProjectYamlFile>;
    expect(() => {
      parsed = parseProjectYamlFile(FIXTURE_PATH);
    }).not.toThrow();

    // Assert required fields parsed correctly
    expect(parsed!.seeds).toBeDefined();
    expect(parsed!.seeds.length).toBeGreaterThan(0);
    expect(parsed!.seeds[0]).toBe('https://example.com/products');
  });

  it('parsed config has correct project name and description', () => {
    const parsed = parseProjectYamlFile(FIXTURE_PATH);
    expect(parsed.name).toBe('E-Commerce Product Catalog');
    expect(parsed.description).toContain('Scrape product');
  });

  it('parsed config has fields array with at least one entry', () => {
    const parsed = parseProjectYamlFile(FIXTURE_PATH);
    expect(parsed.fields).toBeDefined();
    expect(parsed.fields!.length).toBeGreaterThan(0);
  });

  it('parsed config has crawler and depth settings', () => {
    const parsed = parseProjectYamlFile(FIXTURE_PATH);
    expect(parsed.crawler).toBe('playwright');
    expect(parsed.depth).toBe(3);
    expect(parsed.limit).toBe(500);
  });

  it('parsed config has nested crawl, schema, llm, reconciliation, export sections', () => {
    const parsed = parseProjectYamlFile(FIXTURE_PATH);
    expect(parsed.crawl?.concurrency).toBe(5);
    expect(parsed.schema?.mode).toBe('hybrid');
    expect(parsed.llm?.model).toBe('openai/gpt-4o-mini');
    expect(parsed.reconciliation?.strategy).toBe('fuzzy_name');
    expect(parsed.export?.format).toBe('json');
  });
});
