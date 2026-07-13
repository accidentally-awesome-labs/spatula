/**
 * Output-content scanner for LLM extraction results.
 *
 * Detects three categories of suspicious signals in extracted data:
 *
 * 1. prompt_echo — An extracted string value contains a substring of ≥ 40 chars that
 *    also appears verbatim in the system prompt. This suggests the LLM leaked the
 *    system prompt into its output (possibly triggered by an injection attempt).
 *    Threshold: 40 chars. Tuned to avoid false positives from common short phrases
 *    while catching meaningful prompt fragments.
 *
 * 2. field_name_leak — An extracted string value contains the literal name of a
 *    DIFFERENT schema field as a substring. Heuristic: the model used field names as
 *    content rather than extracting actual values — a sign of schema coercion injection.
 *
 * 3. cap_hit — An extracted string value's length equals the applied cap
 *    (field.maxLength ?? DEFAULT_MAX_FIELD_LENGTH = 2000). Equal length means the
 *    value was truncated and the original may have been much longer (possible
 *    exfiltration attempt that was capped).
 *
 * DEFAULT_MAX_FIELD_LENGTH must match the constant in static-extractor.ts.
 */

/** The default max length for a string field — must match static-extractor.ts */
export const DEFAULT_MAX_FIELD_LENGTH = 2000;

/**
 * Minimal schema shape required by the output scanner.
 * Using a structural subset avoids depending on the full SchemaDefinition which
 * carries optional metadata (fieldAliases, createdAt, parentVersion) irrelevant here.
 */
export interface ScanSchema {
  fields: Array<{
    name: string;
    maxLength?: number;
  }>;
}

/** Minimum length of system-prompt substring to trigger a prompt_echo flag. */
const PROMPT_ECHO_MIN_LENGTH = 40;

export interface ScanFlag {
  kind: 'prompt_echo' | 'field_name_leak' | 'cap_hit';
  field?: string;
  detail: string;
}

export interface OutputScanResult {
  suspicious: boolean;
  flags: ScanFlag[];
}

/**
 * Scan LLM extraction output for prompt-injection signals.
 *
 * @param data - The parsed extraction data (keys are field names, values may be any type).
 * @param systemPrompt - The system prompt sent to the LLM (used for prompt-echo detection).
 * @param schema - The extraction schema (used for field-name-leak and cap-hit detection).
 * @returns OutputScanResult with suspicious flag and array of detected issues.
 */
export function scanOutput(
  data: Record<string, unknown>,
  systemPrompt: string,
  schema: ScanSchema,
): OutputScanResult {
  const flags: ScanFlag[] = [];

  const fieldNames = schema.fields.map((f) => f.name);

  for (const [key, rawValue] of Object.entries(data)) {
    if (typeof rawValue !== 'string') continue;
    const value: string = rawValue;

    // ---- 1. Prompt-echo detection ----
    // Slide a window of PROMPT_ECHO_MIN_LENGTH chars across the value and check if
    // any window is a substring of the system prompt.
    const promptEchoFlag = detectPromptEcho(value, systemPrompt, key);
    if (promptEchoFlag) flags.push(promptEchoFlag);

    // ---- 2. Field-name-leak detection ----
    // Check if any OTHER field's name appears verbatim inside this value.
    for (const otherFieldName of fieldNames) {
      if (otherFieldName === key) continue; // skip own field name
      if (value.includes(otherFieldName)) {
        flags.push({
          kind: 'field_name_leak',
          field: key,
          detail: `Field value for "${key}" contains name of schema field "${otherFieldName}"`,
        });
        break; // one flag per field is enough
      }
    }

    // ---- 3. Cap-hit detection ----
    const fieldDef = schema.fields.find((f) => f.name === key);
    const cap =
      fieldDef && 'maxLength' in fieldDef && typeof fieldDef.maxLength === 'number'
        ? fieldDef.maxLength
        : DEFAULT_MAX_FIELD_LENGTH;
    if (value.length === cap) {
      flags.push({
        kind: 'cap_hit',
        field: key,
        detail: `Field "${key}" value length (${value.length}) equals cap (${cap}); value may have been truncated`,
      });
    }
  }

  return {
    suspicious: flags.length > 0,
    flags,
  };
}

/**
 * Detect if any substring of `value` with length ≥ PROMPT_ECHO_MIN_LENGTH
 * appears verbatim in `systemPrompt`.
 *
 * Uses a sliding window approach: for each starting position in `value`,
 * extract a window of PROMPT_ECHO_MIN_LENGTH chars and check membership.
 * Pre-build a Set of all PROMPT_ECHO_MIN_LENGTH-grams from systemPrompt for O(1) lookup.
 */
function detectPromptEcho(value: string, systemPrompt: string, fieldKey: string): ScanFlag | null {
  if (value.length < PROMPT_ECHO_MIN_LENGTH) return null;

  // Build the set of n-grams from the system prompt once
  const ngrams = new Set<string>();
  for (let i = 0; i <= systemPrompt.length - PROMPT_ECHO_MIN_LENGTH; i++) {
    ngrams.add(systemPrompt.slice(i, i + PROMPT_ECHO_MIN_LENGTH));
  }

  // Slide over the value
  for (let i = 0; i <= value.length - PROMPT_ECHO_MIN_LENGTH; i++) {
    const window = value.slice(i, i + PROMPT_ECHO_MIN_LENGTH);
    if (ngrams.has(window)) {
      return {
        kind: 'prompt_echo',
        field: fieldKey,
        detail: `Field "${fieldKey}" contains a ${PROMPT_ECHO_MIN_LENGTH}+ char substring that appears in the system prompt (possible prompt exfiltration)`,
      };
    }
  }

  return null;
}
