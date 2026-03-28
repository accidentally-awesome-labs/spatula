import { describe, it, expect } from 'vitest';
import { StreamingCsvExporter } from '../../../src/exporters/streaming-csv-exporter.js';

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks.map((c) => new TextDecoder().decode(c)).join('');
}

async function* makeEntityBatches(batches: unknown[][]): AsyncIterable<unknown[]> {
  for (const batch of batches) yield batch;
}

describe('StreamingCsvExporter', () => {
  const exporter = new StreamingCsvExporter();

  it('produces CSV with header from first batch and data rows', async () => {
    const batches = [
      [{ mergedData: { name: 'Alice', age: 30 } }, { mergedData: { name: 'Bob', age: 25 } }],
      [{ mergedData: { name: 'Charlie', age: 35 } }],
    ];
    const stream = exporter.export(makeEntityBatches(batches));
    const result = await collectStream(stream);
    const lines = result.trim().split('\n');
    expect(lines[0]).toBe('name,age');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain('Alice');
  });

  it('produces empty output for no batches', async () => {
    const stream = exporter.export(makeEntityBatches([]));
    const result = await collectStream(stream);
    expect(result).toBe('');
  });

  it('uses custom columns parameter for consistent ordering', async () => {
    const batches = [[{ mergedData: { name: 'Alice', age: 30, city: 'NYC' } }]];
    const stream = exporter.export(makeEntityBatches(batches), ['city', 'name', 'age']);
    const result = await collectStream(stream);
    const lines = result.trim().split('\n');
    expect(lines[0]).toBe('city,name,age');
    expect(lines[1]).toContain('NYC');
  });

  it('escapes values with commas, quotes, and newlines', async () => {
    const batches = [[{ mergedData: { name: "O'Brien, Jr.", desc: 'said "hello"', note: 'line1\nline2' } }]];
    const stream = exporter.export(makeEntityBatches(batches));
    const result = await collectStream(stream);
    expect(result).toContain('"O\'Brien, Jr."');
    expect(result).toContain('"said ""hello"""');
  });

  it('sanitizes formula injection characters (=, +, -, @)', async () => {
    const batches = [[{ mergedData: { name: '=SUM(A1)', value: '+cmd' } }]];
    const stream = exporter.export(makeEntityBatches(batches));
    const result = await collectStream(stream);
    // csvEscapeValue from csv-utils.ts prefixes formula chars with a tab inside quotes
    expect(result).toContain('"\t=SUM(A1)"');
    expect(result).toContain('"\t+cmd"');
  });
});
