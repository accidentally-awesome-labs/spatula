import { normalizeGtin } from './gtin';

/*
 * The types a dataset's fields can have, and how a raw value becomes a normalized one. A value
 * that doesn't normalize is rejected with a reason, and never becomes a statement. Each type's
 * key is what makes two values the same value.
 */

export const FIELD_TYPES = ['text', 'enum', 'gtin', 'url', 'specs'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** A record type's field, as a definition declares it, with defaults applied. */
export interface FieldDef {
  type: FieldType;
  required: boolean;
  /** Whether a record holds several values. Specs are always a list. */
  list: boolean;
  identifier: boolean;
  /** The field an identifier is compared within, such as a part number within its brand. */
  scope?: string;
  /** An enum's allowed values, written as the dataset wants them. */
  values?: string[];
  /** The longest text allowed, in characters. */
  maxLength?: number;
  /** Whether the LLM may fill the field when no structured source has it. */
  llm: boolean;
  /**
   * Whether the decision cascade may fill the field when no rule does: a required enum, whose
   * question offers its values and "None of these". Absent means false.
   */
  decide?: boolean;
  /** What the field holds, in words, for the LLM. */
  description?: string;
}

/** A specification as the source writes it, such as Impedance: 300 Ω. */
export interface Spec {
  label: string;
  value: string;
}

export type FieldValue = string | Spec;

export type Normalized =
  | { ok: true; value: FieldValue; key: string }
  | { ok: false; reason: string };

export const TEXT_MAX = 500;
export const URL_MAX = 500;
export const SPEC_LABEL_MAX = 60;
export const SPEC_VALUE_MAX = 200;

const LONG_SPEC = `a spec with a label over ${SPEC_LABEL_MAX} or a value over ${SPEC_VALUE_MAX} characters`;

/**
 * The most that NFC shortens text: four code units can compose into one (U+1F82, alpha with psili,
 * varia, and ypogegrammeni, is four decomposed).
 */
const NFC_MOST_SHRINK = 4;

/**
 * Whether raw text is too long to fit `max` characters however it normalizes. It's judged with
 * whitespace collapsed, as cleanText collapses it, and before anything is normalized: normalizing
 * a long run of combining marks takes time that grows with the square of its length, and a page
 * can hold megabytes of them.
 */
function tooLong(raw: unknown, max: number): boolean {
  return typeof raw === 'string' && raw.replace(/\s+/gu, ' ').trim().length > NFC_MOST_SHRINK * max;
}

/**
 * Text on one line: Unicode-normalized, trimmed, with each run of whitespace as one space.
 * Numbers read as text. Returns `null` for anything else, for empty text, and for text that
 * keeps a control character or an unpaired surrogate. Text from a page is checked with `tooLong`
 * first, so that no more of it than could fit is normalized.
 */
export function cleanText(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  if (typeof raw !== 'string') return null;
  const text = raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
  return text === '' || /\p{Cc}/u.test(text) || !text.isWellFormed() ? null : text;
}

/** How specs' labels compare: "Frequency response" and "frequency  Response" are one label. */
export function specLabelKey(label: string): string {
  return label.toLowerCase().replace(/\s+/gu, ' ').trim();
}

/** A raw value as the field keeps it, or why it can't be kept. */
export function normalizeValue(field: FieldDef, raw: unknown): Normalized {
  switch (field.type) {
    case 'text':
      return text(raw, field.maxLength ?? TEXT_MAX);
    case 'enum':
      return choice(raw, field.values ?? []);
    case 'gtin': {
      const gtin =
        typeof raw === 'string' || typeof raw === 'number' ? normalizeGtin(String(raw)) : null;
      return gtin === null
        ? { ok: false, reason: 'not a GTIN with a valid check digit' }
        : { ok: true, value: gtin, key: gtin };
    }
    case 'url':
      return webAddress(raw);
    case 'specs':
      return spec(raw);
  }
}

function text(raw: unknown, max: number): Normalized {
  const long = { ok: false, reason: `longer than ${max} characters` } as const;
  if (tooLong(raw, max)) return long;
  const value = cleanText(raw);
  if (value === null) return { ok: false, reason: 'not text, or empty' };
  if (value.length > max) return long;
  return { ok: true, value, key: value };
}

function choice(raw: unknown, values: string[]): Normalized {
  // Lowercasing never shortens text, so nothing longer than the longest allowed value, lowercased,
  // can match one.
  const longest = values.reduce((most, value) => Math.max(most, value.toLowerCase().length), 0);
  const written = tooLong(raw, longest) ? null : cleanText(raw);
  const match =
    written === null
      ? undefined
      : values.find((value) => value.toLowerCase() === written.toLowerCase());
  return match === undefined
    ? { ok: false, reason: `not one of ${values.join(', ')}` }
    : { ok: true, value: match, key: match };
}

function webAddress(raw: unknown): Normalized {
  // The URL parser cleans the address it returns, but the raw text is kept as the statement's
  // original. Postgres can't store a NUL, and an unpaired surrogate isn't text, so the raw text
  // is checked first.
  if (
    typeof raw !== 'string' ||
    raw.includes('\u0000') ||
    !raw.isWellFormed() ||
    !URL.canParse(raw.trim())
  )
    return { ok: false, reason: 'not a web address' };
  const url = new URL(raw.trim());
  if (url.protocol !== 'https:') return { ok: false, reason: 'not an https:// address' };
  url.hash = '';
  return url.href.length > URL_MAX
    ? { ok: false, reason: `longer than ${URL_MAX} characters` }
    : { ok: true, value: url.href, key: url.href };
}

function spec(raw: unknown): Normalized {
  if (typeof raw !== 'object' || raw === null || !('label' in raw) || !('value' in raw)) {
    return { ok: false, reason: 'not a label and a value' };
  }
  if (tooLong(raw.label, SPEC_LABEL_MAX) || tooLong(raw.value, SPEC_VALUE_MAX)) {
    return { ok: false, reason: LONG_SPEC };
  }
  const label = cleanText(raw.label);
  const value = cleanText(typeof raw.value === 'boolean' ? (raw.value ? 'Yes' : 'No') : raw.value);
  if (label === null || value === null) return { ok: false, reason: 'missing a label or a value' };
  if (label.length > SPEC_LABEL_MAX || value.length > SPEC_VALUE_MAX) {
    return { ok: false, reason: LONG_SPEC };
  }
  return { ok: true, value: { label, value }, key: `${specLabelKey(label)}\u001f${value}` };
}
