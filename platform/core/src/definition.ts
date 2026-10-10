import { z } from 'zod';
import { selectorError } from './css';
import { FIELD_TYPES, normalizeValue, type FieldDef } from './fields';

/*
 * A dataset definition: the record type a dataset keeps, its fields and identity, the sources it
 * reads, and its collection policy. Owners write definitions as YAML in their own repository; the
 * CLI checks them and sends them as JSON, and the API checks them again with the same schema.
 * This is slice 0's subset: one record type, sources that are lists of pages, and rules a person
 * declares. ADR 0002 explains the format.
 */

type Path = (string | number)[];
type Report = (path: Path, message: string) => void;

const NAME = /^[a-z][a-zA-Z0-9]*$/u;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

const name = z.string().regex(NAME, 'Use a camelCase name, like officialUrl.');
const slug = z
  .string()
  .regex(SLUG, 'Use lowercase letters, digits, and hyphens, up to 63 characters.');
const httpsUrl = z.url({ protocol: /^https$/u, error: 'Use an https:// address.' });
const isoDate = z.iso.date({ error: 'Write the date as YYYY-MM-DD.' });

const fieldSchema = z
  .strictObject({
    type: z.enum(FIELD_TYPES),
    required: z.boolean().default(false),
    list: z.boolean().default(false),
    identifier: z.boolean().default(false),
    scope: name.optional(),
    values: z.array(z.string().trim().min(1)).min(1).optional(),
    maxLength: z.number().int().min(1).max(10_000).optional(),
    llm: z.boolean().default(false),
    description: z.string().trim().min(1).max(300).optional(),
  })
  .transform((field): FieldDef => (field.type === 'specs' ? { ...field, list: true } : field));

const ruleSchema = z.union([
  z.strictObject({
    css: z.string().trim().min(1).max(200),
    attr: z.string().trim().min(1).max(60).optional(),
  }),
  z.strictObject({ url: z.literal('canonical') }),
]);
export type Rule = z.output<typeof ruleSchema>;

const sourceSchema = z.strictObject({
  id: slug,
  kind: z.literal('pages'),
  recordType: name,
  pages: z.array(httpsUrl).min(1).max(1000),
  fixed: z.record(name, z.unknown()).default({}),
  extract: z.record(name, ruleSchema).default({}),
  evidence: z.strictObject({
    robots: isoDate,
    terms: z.strictObject({
      url: httpsUrl,
      checked: isoDate,
      automatedAccess: z.enum(['allowed', 'not-mentioned', 'forbidden']),
    }),
  }),
});

const recordTypeSchema = z.strictObject({
  pack: z
    .string()
    .regex(/^[a-z0-9-]+\/[a-z0-9-]+$/u, 'Name a pack and record type, like products/product.')
    .optional(),
  identity: z.strictObject({
    identifiers: z.array(name).default([]),
    keys: z.array(z.array(name).min(1)).default([]),
  }),
  fields: z.record(name, fieldSchema),
});

const policySchema = z.strictObject({
  purposes: z.array(z.enum(['search', 'ai-input'])).default([]),
  perHostIntervalMs: z.number().int().min(1000).max(600_000).default(1000),
});

const shapeSchema = z.strictObject({
  dataset: slug,
  recordTypes: z.record(name, recordTypeSchema),
  sources: z.array(sourceSchema).min(1),
  policy: policySchema.default({ purposes: [], perHostIntervalMs: 1000 }),
});

export const definitionSchema = shapeSchema.superRefine((definition, ctx) =>
  checkDefinition(definition, (path, message) => ctx.addIssue({ code: 'custom', path, message })),
);

export type Definition = z.output<typeof shapeSchema>;
export type RecordType = Definition['recordTypes'][string];
export type Source = Definition['sources'][number];

/** A definition, with defaults filled in, or every problem with it as `path: message`. */
export function parseDefinition(
  input: unknown,
): { ok: true; definition: Definition } | { ok: false; issues: string[] } {
  const result = definitionSchema.safeParse(input);
  if (result.success) return { ok: true, definition: result.data };
  return {
    ok: false,
    issues: result.error.issues.map(
      (issue) =>
        `${issue.path.length > 0 ? issue.path.map(String).join('.') : '(definition)'}: ${issue.message}`,
    ),
  };
}

function checkDefinition(definition: z.output<typeof shapeSchema>, report: Report): void {
  const typeNames = Object.keys(definition.recordTypes);
  if (typeNames.length !== 1) {
    report(
      ['recordTypes'],
      'Declare exactly one record type. Datasets with several arrive in a later version.',
    );
  }
  for (const [typeName, recordType] of Object.entries(definition.recordTypes)) {
    checkRecordType(['recordTypes', typeName], recordType, report);
  }
  const sourceIds = new Set<string>();
  const pages = new Set<string>();
  definition.sources.forEach((source, index) => {
    const at: Path = ['sources', index];
    if (sourceIds.has(source.id))
      report([...at, 'id'], `Another source is also called ${source.id}.`);
    sourceIds.add(source.id);
    for (const page of source.pages) {
      if (pages.has(page)) report([...at, 'pages'], `${page} is listed twice.`);
      pages.add(page);
    }
    if (source.evidence.terms.automatedAccess === 'forbidden') {
      report(
        [...at, 'evidence', 'terms', 'automatedAccess'],
        'The site’s terms forbid automated access, so Spatula can’t collect this source.',
      );
    }
    const recordType = definition.recordTypes[source.recordType];
    if (recordType === undefined) {
      report([...at, 'recordType'], `There’s no record type called ${source.recordType}.`);
    } else {
      checkSource(at, source, recordType, report);
    }
  });
}

function checkRecordType(at: Path, recordType: RecordType, report: Report): void {
  const { fields, identity } = recordType;
  if (identity.identifiers.length === 0 && identity.keys.length === 0) {
    report(
      [...at, 'identity'],
      'Name at least one identifier or key, so records can be told apart.',
    );
  }
  identity.identifiers.forEach((fieldName, index) => {
    const field = fields[fieldName];
    const path = [...at, 'identity', 'identifiers', index];
    if (field === undefined) report(path, `There’s no field called ${fieldName}.`);
    else if (!field.identifier)
      report(path, `Mark ${fieldName} as an identifier (identifier: true).`);
  });
  identity.keys.forEach((key, index) =>
    key.forEach((fieldName, position) => {
      const field = fields[fieldName];
      const path = [...at, 'identity', 'keys', index, position];
      if (field === undefined) report(path, `There’s no field called ${fieldName}.`);
      else if (field.list || (field.type !== 'text' && field.type !== 'enum')) {
        report(path, `Key fields must be single text or enum values; ${fieldName} isn’t.`);
      }
    }),
  );

  // Whatever decides which record an item belongs to stays out of the LLM's hands.
  const identifying = new Set([...identity.identifiers, ...identity.keys.flat()]);
  for (const field of Object.values(fields)) {
    if (field.identifier && field.scope !== undefined) identifying.add(field.scope);
  }

  for (const [fieldName, field] of Object.entries(fields)) {
    const path = [...at, 'fields', fieldName];
    if (field.type === 'enum' && field.values === undefined)
      report([...path, 'values'], 'List the allowed values.');
    if (field.type !== 'enum' && field.values !== undefined)
      report([...path, 'values'], 'Only enum fields have values.');
    if (field.maxLength !== undefined && field.type !== 'text') {
      report([...path, 'maxLength'], 'Only text fields have a maxLength.');
    }
    if (field.identifier && field.type !== 'gtin' && field.type !== 'text') {
      report([...path, 'identifier'], 'Identifiers are GTINs or text.');
    }
    if (field.scope !== undefined) {
      const scope = fields[field.scope];
      if (!field.identifier) report([...path, 'scope'], 'Only identifiers have a scope.');
      else if (scope === undefined || scope.list || scope.type !== 'text') {
        report([...path, 'scope'], `The scope must be a single text field; ${field.scope} isn’t.`);
      }
    }
    if (field.llm) {
      if (field.type !== 'specs')
        report([...path, 'llm'], 'In this version, the LLM fills specs fields only.');
      if (field.identifier || identifying.has(fieldName)) {
        report(
          [...path, 'llm'],
          'Fields that identify a record come from structured data or declared rules, never the LLM.',
        );
      }
    }
  }
}

function checkSource(at: Path, source: Source, recordType: RecordType, report: Report): void {
  for (const [fieldName, value] of Object.entries(source.fixed)) {
    const field = recordType.fields[fieldName];
    const path = [...at, 'fixed', fieldName];
    if (field === undefined) {
      report(path, `There’s no field called ${fieldName}.`);
      continue;
    }
    for (const one of field.list && Array.isArray(value) ? value : [value]) {
      const normalized = normalizeValue(field, one);
      if (!normalized.ok) report(path, `${quoted(one)} is ${normalized.reason}.`);
    }
    if (fieldName in source.extract) {
      report(
        [...at, 'extract', fieldName],
        `${fieldName} is fixed, so it can’t also be extracted.`,
      );
    }
  }
  for (const [fieldName, rule] of Object.entries(source.extract)) {
    const field = recordType.fields[fieldName];
    const path = [...at, 'extract', fieldName];
    if (field === undefined) {
      report(path, `There’s no field called ${fieldName}.`);
    } else if ('url' in rule) {
      if (field.type !== 'url') report(path, 'Only url fields can take the page address.');
    } else {
      const error = selectorError(rule.css);
      if (error !== null) report([...path, 'css'], `The selector doesn’t parse: ${error}`);
      if (field.type === 'specs')
        report(path, 'Specs come from structured data or the LLM, not a selector.');
    }
  }
}

function quoted(value: unknown): string {
  return `“${typeof value === 'string' ? value : JSON.stringify(value)}”`;
}
