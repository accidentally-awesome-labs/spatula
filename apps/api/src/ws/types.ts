export type WSMessageType =
  | 'crawl_progress'
  | 'task_completed'
  | 'schema_evolved'
  | 'action_pending'
  | 'job_status_changed'
  | 'entity_created'
  | 'error'
  | 'connected'
  | 'ping';

export interface WSMessage {
  type: WSMessageType;
  timestamp: number;
  data: Record<string, unknown>;
}
