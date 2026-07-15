// apps/api/src/embedded-worker.ts
// Embedded-worker shim — conditionally starts the BullMQ worker in-process
// alongside the API server when SPATULA_EMBEDDED_WORKER=1 is set.
//
// The injectable factory parameter makes this unit-testable without booting
// real BullMQ connections. The production default lazily imports @accidentally-awesome-labs/spatula-queue
// so the module is only loaded when the flag is actually set.

import type { WorkerHandle } from '@accidentally-awesome-labs/spatula-queue';

/**
 * Start the BullMQ worker in-process if SPATULA_EMBEDDED_WORKER=1.
 *
 * @param startWorkerFn Optional factory — defaults to `startWorker` from
 *   @accidentally-awesome-labs/spatula-queue. Pass a mock factory in tests.
 * @returns The WorkerHandle (with shutdown()) when started, or null when the
 *   flag is absent/not "1" (worker code path is entirely untouched).
 */
export async function startEmbeddedWorker(
  startWorkerFn?: () => Promise<WorkerHandle>,
): Promise<WorkerHandle | null> {
  if (process.env.SPATULA_EMBEDDED_WORKER !== '1') return null;

  const factory =
    startWorkerFn ??
    (async () => {
      const { startWorker } = await import('@accidentally-awesome-labs/spatula-queue');
      return startWorker();
    });

  return factory();
}
