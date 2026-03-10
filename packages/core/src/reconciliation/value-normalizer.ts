import type { NormalizationRule } from '../types/normalization.js';
import type { SchemaDefinition } from '../types/schema.js';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface NormalizationChange {
  fieldName: string;
  before: unknown;
  after: unknown;
}

export interface NormalizedResult {
  normalizedData: Record<string, unknown>;
  changes: NormalizationChange[];
}

// ---------------------------------------------------------------------------
// Unit conversion tables
// ---------------------------------------------------------------------------

/** Conversion factors to a common base unit within each dimension. */
const UNIT_TO_BASE: Record<string, { base: string; factor: number }> = {
  // mass — base: g
  g: { base: 'g', factor: 1 },
  kg: { base: 'g', factor: 1000 },
  oz: { base: 'g', factor: 28.349523125 },
  lb: { base: 'g', factor: 453.59237 },
  // length — base: mm
  mm: { base: 'mm', factor: 1 },
  cm: { base: 'mm', factor: 10 },
  m: { base: 'mm', factor: 1000 },
};

function convertMeasurement(
  value: number,
  fromUnit: string,
  toUnit: string,
): { value: number; unit: string } | null {
  const from = UNIT_TO_BASE[fromUnit];
  const to = UNIT_TO_BASE[toUnit];

  if (!from || !to || from.base !== to.base) {
    return null; // incompatible dimensions
  }

  const baseValue = value * from.factor;
  const converted = baseValue / to.factor;
  // toPrecision(10) suppresses floating-point noise that arises in unit
  // conversions with non-power-of-two factors (e.g. oz↔lb) so that
  // 32 oz → 2 lb rather than 1.9999999999… lb.
  return { value: Number(converted.toPrecision(10)), unit: toUnit };
}

// ---------------------------------------------------------------------------
// Currency helpers
// ---------------------------------------------------------------------------

const CURRENCY_SYMBOLS = /^[\$\u20AC\u00A3\u00A5]\s*/; // $, EUR sign, GBP sign, JPY sign
const CURRENCY_CODES = /\s*(USD|EUR|GBP|JPY|CAD|AUD|CHF|CNY|INR|BRL)\s*/i;

function parseCurrency(raw: string): number | null {
  let cleaned = raw.replace(CURRENCY_SYMBOLS, '').replace(CURRENCY_CODES, '').trim();
  // Strip thousands separators (commas)
  cleaned = cleaned.replace(/,/g, '');
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function toTitleCase(str: string): string {
  return str.replace(/\S+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

// ---------------------------------------------------------------------------
// Measurement parser
// ---------------------------------------------------------------------------

const MEASUREMENT_RE = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)$/;

function parseMeasurement(raw: string): { value: number; unit: string } | null {
  const match = raw.trim().match(MEASUREMENT_RE);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (!Number.isFinite(value)) return null;
  return { value, unit };
}

// ---------------------------------------------------------------------------
// applyNormalizationRule
// ---------------------------------------------------------------------------

export function applyNormalizationRule(value: unknown, rule: NormalizationRule): unknown {
  switch (rule.type) {
    case 'text':
      return applyTextRule(value, rule.config);
    case 'enum':
      return applyEnumRule(value, rule.config);
    case 'currency':
      return applyCurrencyRule(value, rule.config);
    case 'boolean':
      return applyBooleanRule(value, rule.config);
    case 'list':
      return applyListRule(value, rule.config);
    case 'measurement':
      return applyMeasurementRule(value, rule.config);
    case 'llm':
      return value; // no-op — async LLM handled elsewhere
  }
}

// ---------------------------------------------------------------------------
// Rule implementations
// ---------------------------------------------------------------------------

function applyTextRule(
  value: unknown,
  config: { casing?: string; trim?: boolean; collapseWhitespace?: boolean },
): unknown {
  if (typeof value !== 'string') return value;

  let result = value;

  if (config.trim !== false) {
    result = result.trim();
  }

  if (config.collapseWhitespace !== false) {
    result = result.replace(/\s+/g, ' ');
  }

  switch (config.casing) {
    case 'lower':
      result = result.toLowerCase();
      break;
    case 'upper':
      result = result.toUpperCase();
      break;
    case 'title':
      result = toTitleCase(result);
      break;
    case 'preserve':
    default:
      break;
  }

  return result;
}

function applyEnumRule(
  value: unknown,
  config: { canonicalValues: string[]; synonymMap: Record<string, string> },
): unknown {
  if (typeof value !== 'string') return value;

  const mapped = config.synonymMap[value];
  if (mapped !== undefined) return mapped;

  return value;
}

function applyCurrencyRule(
  value: unknown,
  config: { targetCurrency?: string; decimalPlaces?: number },
): unknown {
  const dp = config.decimalPlaces ?? 2;

  if (typeof value === 'number') {
    return Number(value.toFixed(dp));
  }

  if (typeof value !== 'string') return value;

  const parsed = parseCurrency(value);
  if (parsed === null) return value;

  return Number(parsed.toFixed(dp));
}

function applyBooleanRule(
  value: unknown,
  config: { trueValues?: string[]; falseValues?: string[] },
): unknown {
  if (typeof value !== 'string') return value;

  const lower = value.toLowerCase();

  const trueVals = config.trueValues ?? ['yes', 'true', '1', 'available'];
  const falseVals = config.falseValues ?? ['no', 'false', '0', 'unavailable'];

  if (trueVals.some((v) => v.toLowerCase() === lower)) return true;
  if (falseVals.some((v) => v.toLowerCase() === lower)) return false;

  return value;
}

function applyListRule(value: unknown, config: { separator?: string }): unknown {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return value;

  const separator = config.separator ?? ',';
  return value.split(separator).map((item) => item.trim());
}

function applyMeasurementRule(
  value: unknown,
  config: { targetUnit?: string; format?: string },
): unknown {
  if (typeof value !== 'string') return value;

  const parsed = parseMeasurement(value);
  if (!parsed) return value;

  if (!config.targetUnit) {
    return parsed;
  }

  if (parsed.unit === config.targetUnit) {
    return parsed;
  }

  const converted = convertMeasurement(parsed.value, parsed.unit, config.targetUnit);
  if (!converted) {
    // Incompatible units — return parsed as-is
    return parsed;
  }

  return converted;
}

// ---------------------------------------------------------------------------
// normalizeExtractionData
// ---------------------------------------------------------------------------

export function normalizeExtractionData(
  data: Record<string, unknown>,
  schema: SchemaDefinition,
): NormalizedResult {
  const normalizedData: Record<string, unknown> = { ...data };
  const changes: NormalizationChange[] = [];

  // Build a lookup of field name → normalization rule
  const ruleMap = new Map<string, NormalizationRule>();
  for (const field of schema.fields) {
    if (field.normalization) {
      ruleMap.set(field.name, field.normalization);
    }
  }

  for (const [key, original] of Object.entries(data)) {
    const rule = ruleMap.get(key);
    if (!rule) continue;

    const normalized = applyNormalizationRule(original, rule);
    normalizedData[key] = normalized;

    if (!deepEqual(original, normalized)) {
      changes.push({ fieldName: key, before: original, after: normalized });
    }
  }

  return { normalizedData, changes };
}

// ---------------------------------------------------------------------------
// Simple deep equality for change detection
// ---------------------------------------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // NaN === NaN is false in JS; treat two NaN values as equal to avoid phantom changes
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b))
    return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;

  if (typeof a === 'object' && typeof b === 'object') {
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      return a.every((item, index) => deepEqual(item, b[index]));
    }

    if (Array.isArray(a) || Array.isArray(b)) return false;

    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);

    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => deepEqual(aObj[key], bObj[key]));
  }

  return false;
}
