export const WEBHOOK_EVENT_TYPES = [
  'job.completed',
  'job.failed',
  'job.cancelled',
  'export.completed',
  'action.pending',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export interface WebhookEvent {
  id: string;
  type: WebhookEventType;
  timestamp: string;
  data: {
    jobId: string;
    tenantId: string;
    status?: string;
    entityCount?: number;
    duration?: number;
  };
}

export interface WebhookConfig {
  url: string;
  secret?: string;
  events: WebhookEventType[];
}
