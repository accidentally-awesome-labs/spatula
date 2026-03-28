const encoder = new TextEncoder();

function escapeCsvValue(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

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
              controller.enqueue(encoder.encode(resolvedColumns.join(',') + '\n'));
              headerWritten = true;
            }
            const row = resolvedColumns.map((col) => escapeCsvValue(data[col]));
            controller.enqueue(encoder.encode(row.join(',') + '\n'));
          }
        }
        controller.close();
      },
    });
  }
}
