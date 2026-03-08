import { z } from 'zod';
import type { PipelineAction } from '../types/actions.js';

export const StateChange = z.object({
  path: z.string(),
  before: z.unknown(),
  after: z.unknown(),
});

export type StateChange = z.infer<typeof StateChange>;

export const ActionResult = z.object({
  actionId: z.string().uuid(),
  status: z.enum(['applied', 'rejected', 'deferred']),
  stateChanges: z.array(StateChange),
  rejectionReason: z.string().optional(),
});

export type ActionResult = z.infer<typeof ActionResult>;

export const ActionPreview = z.object({
  actionId: z.string().uuid(),
  wouldChange: z.array(StateChange),
  riskLevel: z.enum(['low', 'medium', 'high']),
  requiresApproval: z.boolean(),
});

export type ActionPreview = z.infer<typeof ActionPreview>;

export interface ActionExecutor {
  execute(action: PipelineAction): Promise<ActionResult>;
  rollback(actionId: string): Promise<void>;
  preview(action: PipelineAction): Promise<ActionPreview>;
}
