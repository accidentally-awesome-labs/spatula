/*
 * Publication gates (ADR 0004), after the catalog engine's. A snapshot publishes when its dataset's
 * approval preset and the removal guard allow it, and is held for the owner otherwise. "auto"
 * publishes unless the guard trips; "balanced" also holds the dataset's first publication and its
 * first after the definition changed, which is when new sources and fields arrive; "manual" holds
 * every one. The guard trips when a snapshot drops more of the last published records than the
 * dataset allows: more than `count`, or more than `share` of them.
 */

export type Approval = 'auto' | 'balanced' | 'manual';

export interface GateInput {
  approval: Approval;
  maxRemovals: { count: number; share: number };
  /** The last published snapshot: its records' IDs, and the definition revision it came from. */
  previous: { canonicalIds: readonly string[]; revision: number | null } | null;
  next: { canonicalIds: readonly string[]; revision: number };
}

export interface GateResult {
  publish: boolean;
  /** Why the snapshot is held, in words; empty when it publishes. */
  reasons: string[];
  added: number;
  removed: number;
}

export function checkGates(input: GateInput): GateResult {
  const before = new Set(input.previous?.canonicalIds ?? []);
  const after = new Set(input.next.canonicalIds);
  const removed = [...before].filter((id) => !after.has(id)).length;
  const added = [...after].filter((id) => !before.has(id)).length;
  const reasons: string[] = [];
  const { count, share } = input.maxRemovals;
  if (removed > count || removed > before.size * share) {
    reasons.push(
      `it drops ${removed} of ${before.size} published records, more than the guard allows (${count} records or ${Math.round(share * 100)}%)`,
    );
  }
  if (input.approval === 'manual') reasons.push('the dataset’s approval is manual');
  if (input.approval === 'balanced') {
    if (input.previous === null) {
      reasons.push('it’s the dataset’s first publication');
    } else if (input.previous.revision !== input.next.revision) {
      reasons.push(
        `the definition changed since the last publication (revision ${input.previous.revision ?? 'unknown'} to ${input.next.revision})`,
      );
    }
  }
  return { publish: reasons.length === 0, reasons, added, removed };
}
