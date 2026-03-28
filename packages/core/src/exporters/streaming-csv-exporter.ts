import { csvEscapeValue, csvEscapeHeader } from './csv-utils.js';

const encoder = new TextEncoder();

export class StreamingCsvExporter {
  export(entityBatches: AsyncIterable<unknown[]>, columns?: string[]): ReadableStream<Uint8Array> {
    let headerWritten = false;
    let resolvedColumns: string[] = columns ?? [];

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        for await (const batch of entityBatches) {
          for (const entity of batch) {
            const data = (entity as any).mergedData ?? entity;
            if (!headerWritten) {
              if (resolvedColumns.length === 0) resolvedColumns = Object.keys(data);
              controller.enqueue(encoder.encode(resolvedColumns.map(csvEscapeHeader).join(',') + '\n'));
              headerWritten = true;
            }
            const val = (v: unknown) => (v === null || v === undefined ? '' : String(v));
            const row = resolvedColumns.map((col) => csvEscapeValue(val(data[col])));
            controller.enqueue(encoder.encode(row.join(',') + '\n'));
          }
        }
        controller.close();
      },
    });
  }
}
