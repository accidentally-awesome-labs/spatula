import { EventEmitter } from 'node:events';

export interface PipelineEvents {
  'task:completed': (task: { id: string; url: string; status: string }) => void;
  'entity:created': (entity: { id: string; jobId: string }) => void;
  'schema:evolved': (schema: { version: number; fields: unknown[] }) => void;
  'action:pending': (action: { id: string; type: string }) => void;
  progress: (stats: {
    pagesProcessed: number;
    totalPages: number;
    entitiesCreated: number;
    errors: number;
  }) => void;
}

export class PipelineEventEmitter extends EventEmitter {
  emit<K extends keyof PipelineEvents>(event: K, ...args: Parameters<PipelineEvents[K]>): boolean {
    return super.emit(event, ...args);
  }
  on<K extends keyof PipelineEvents>(event: K, listener: PipelineEvents[K]): this {
    return super.on(event, listener as (...args: any[]) => void);
  }
}
