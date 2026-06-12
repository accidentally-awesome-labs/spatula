// packages/queue/src/usage-context.ts
// AsyncLocalStorage store that carries the active {tenantId, jobId} context
// through the entire async call chain of a BullMQ job handler.
// This gives the AlsUsageRecorder race-safe per-job attribution without
// thread-locals or explicit parameter threading.

import { AsyncLocalStorage } from 'node:async_hooks';

export interface UsageContext {
  tenantId: string;
  jobId: string;
}

export const usageContext = new AsyncLocalStorage<UsageContext>();

export function currentUsageContext(): UsageContext | undefined {
  return usageContext.getStore();
}
