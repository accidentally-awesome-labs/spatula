const encoder = new TextEncoder();

export class StreamingJsonExporter {
  export(entityBatches: AsyncIterable<unknown[]>): ReadableStream<Uint8Array> {
    let isFirst = true;
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode('['));
        for await (const batch of entityBatches) {
          for (const entity of batch) {
            if (!isFirst) controller.enqueue(encoder.encode(','));
            controller.enqueue(encoder.encode(JSON.stringify(entity)));
            isFirst = false;
          }
        }
        controller.enqueue(encoder.encode(']'));
        controller.close();
      },
    });
  }
}
