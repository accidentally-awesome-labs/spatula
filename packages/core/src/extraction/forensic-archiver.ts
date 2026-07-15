/**
 * Forensic archiver.
 *
 * When a suspicious extraction or off-schema retry fires, the raw HTML is
 * archived to the content store under the `forensic/` key prefix and a
 * `suspicious_extraction` DLQ entry is written for audit and investigation.
 *
 * Design constraints:
 * - Raw HTML goes ONLY to the content store, NEVER to the DLQ payload.
 * - DLQ payload carries only metadata: extractionId, forensicRef, reason, scanFlags.
 * - The `dlqWriter` is injected as a minimal structural interface so @accidentally-awesome-labs/spatula-core
 *   does not import @accidentally-awesome-labs/spatula-db (no circular dep).
 * - Each call produces a distinct timestamped key; archival is NOT idempotent
 *   (each suspicious event is its own forensic record).
 */
import type { ContentStore } from '../interfaces/content-store.js';
import { createLogger } from '@accidentally-awesome-labs/spatula-shared';

const logger = createLogger('forensic-archiver');

/** Prefix for all forensic blobs in the content store. */
export const FORENSIC_KEY_PREFIX = 'forensic/';

/**
 * Input descriptor for a forensic archive operation.
 */
export interface ForensicArchiveInput {
  /** Tenant that owns the extraction. */
  tenantId: string;
  /** The extraction record ID being archived. */
  extractionId: string;
  /** Raw (pre-preprocessed) HTML page content — goes to content store ONLY. */
  rawHtml: string;
  /** Why this archival was triggered. */
  reason: 'suspicious_extraction' | 'off_schema_retry';
  /** Scan flags from the output-content scanner — metadata only, no HTML. */
  scanFlags: unknown[];
}

/**
 * Minimal structural interface for the DLQ writer.
 * Matches the insert signature of @accidentally-awesome-labs/spatula-db's DlqRepository without importing it.
 */
export interface ForensicDlqWriter {
  insert(record: ForensicDlqRecord): Promise<void>;
}

/**
 * The record shape written to the DLQ for each forensic archival.
 * Intentionally omits raw HTML — only metadata is stored in the DLQ.
 */
export interface ForensicDlqRecord {
  queueName: string;
  jobId: string;
  tenantId: string;
  payload: {
    extractionId: string;
    forensicRef: string;
    reason: string;
    scanFlags: unknown[];
  };
  attempts: number;
  failedAt: Date;
}

/**
 * Archive a suspicious or off-schema extraction for forensic review.
 *
 * Steps:
 * 1. Build the forensic key: `forensic/{tenantId}/{extractionId}/{Date.now()}.html`
 * 2. Store rawHtml in the content store under that key
 * 3. Write a DLQ record (queueName = 'suspicious_extraction') with ONLY metadata
 *    in the payload — raw HTML is never written to the DLQ
 * 4. Return the forensic content ref produced by the content store
 *
 * @returns The forensic content ref (as returned by contentStore.store)
 */
export async function archiveForensicExtraction(
  deps: {
    contentStore: ContentStore;
    dlqWriter: ForensicDlqWriter;
  },
  input: ForensicArchiveInput,
): Promise<string> {
  const { contentStore, dlqWriter } = deps;
  const { tenantId, extractionId, rawHtml, reason, scanFlags } = input;

  // Build the forensic key — timestamped so each suspicious event has its own record
  const timestamp = Date.now();
  const key = `${FORENSIC_KEY_PREFIX}${tenantId}/${extractionId}/${timestamp}.html`;

  // Step 1: archive raw HTML to content store (this is the ONLY place it goes)
  let forensicRef: string;
  try {
    forensicRef = await contentStore.store(key, rawHtml);
  } catch (err) {
    logger.error(
      { tenantId, extractionId, reason, err },
      'forensic-archiver: failed to store raw HTML to content store',
    );
    throw err;
  }

  // Step 2: write DLQ record — payload carries ONLY metadata, NOT the raw HTML
  const dlqRecord: ForensicDlqRecord = {
    queueName: 'suspicious_extraction',
    // Use the extractionId as the BullMQ job ID placeholder — forensic archival
    // is not a real BullMQ job, but DLQ schema requires a non-null jobId.
    jobId: extractionId,
    tenantId,
    payload: {
      extractionId,
      forensicRef,
      reason,
      // scanFlags contain metadata only (kind, field, detail strings) — no HTML
      scanFlags,
    },
    attempts: 1,
    failedAt: new Date(),
  };

  try {
    await dlqWriter.insert(dlqRecord);
  } catch (err) {
    // DLQ write failure is logged but non-fatal: the blob is already archived.
    // An operator can reconstruct DLQ entries from the content store.
    logger.error(
      { tenantId, extractionId, reason, forensicRef, err },
      'forensic-archiver: DLQ write failed (blob archived, DLQ entry missing)',
    );
  }

  logger.debug(
    { tenantId, extractionId, reason, forensicRef, flags: scanFlags.length },
    'forensic extraction archived',
  );

  return forensicRef;
}
