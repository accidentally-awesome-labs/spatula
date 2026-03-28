import { describe, it, expect } from 'vitest';
import { StreamingJsonExporter } from '../../../src/exporters/streaming-json-exporter.js';

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

describe('StreamingJsonExporter', () => {
  const exporter = new StreamingJsonExporter();

  it('produces valid JSON array from multiple batches', async () => {
    const batches = [
      [{ id: '1', mergedData: { name: 'A' } }, { id: '2', mergedData: { name: 'B' } }],
      [{ id: '3', mergedData: { name: 'C' } }],
    ];
    const stream = exporter.export(makeEntityBatches(batches));
    const result = await collectStream(stream);
    const parsed = JSON.parse(result);
    expect(parsed).toHaveLength(3);
    expect(parsed[0].mergedData.name).toBe('A');
  });

  it('produces empty array for no batches', async () => {
    const stream = exporter.export(makeEntityBatches([]));
    const result = await collectStream(stream);
    expect(JSON.parse(result)).toEqual([]);
  });

  it('produces valid JSON for single entity', async () => {
    const stream = exporter.export(makeEntityBatches([[{ id: '1', mergedData: { name: 'Solo' } }]]));
    const result = await collectStream(stream);
    expect(JSON.parse(result)).toHaveLength(1);
  });
});
