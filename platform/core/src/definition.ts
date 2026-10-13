import { z } from 'zod';
import { selectorError } from './css';
import { NONE_OF_THESE } from './decision-types';
import { FIELD_TYPES, normalizeValue, type FieldDef } from './fields';

/*
 * A dataset definition: the record type a dataset keeps, its fields and identity, the sources it
 * reads, and its collection policy. Owners write definitions as YAML in their own repository; the
 * CLI checks them and sends them as JSON, and the API checks them again with the same schema.
 * This is version 2: one record type, sources that list pages or read sitemaps, rules a person
 * declares, and the dataset's freshness, gates, publication, decisions, budget, and consumers.
 * Every key added since slice 0 has a default. ADR 0002 explains the format.
 */

type Path = (string | number)[];
type Report = (path: Path, message: string) => void;

const NAME = /^[a-z][a-zA-Z0-9]*$/u;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

// Names are looked up in plain objects, which already have constructor, toString, and a few more
// of their own. The refusal aborts the parse, so no cross-check ever looks a reserved name up.
const name = z
  .string()
  .regex(NAME, 'Use a camelCase name, like officialUrl.')
  .refine((value) => !(value in Object.prototype), {
    error: 'That name is reserved. Pick another.',
    abort: true,
  });
const slug = z
  .string()
  .regex(SLUG, 'Use lowercase letters, digits, and hyphens, up to 63 characters.');
const httpsUrl = z
  .url({ protocol: /^https$/u, error: 'Use an https:// address.' })
  .superRefine((value, ctx) => {
    // An address that doesn't parse has been reported already, so it's skipped here.
    const reason = URL.canParse(value) ? addressError(new URL(value)) : null;
    if (reason !== null) {
      ctx.addIssue({
        code: 'custom',
        message: `This address is ${reason}. Use the site’s public https:// address.`,
      });
    }
  });
const isoDate = z.iso.date({ error: 'Write the date as YYYY-MM-DD.' });

const fieldSchema = z
  .strictObject({
    type: z.enum(FIELD_TYPES),
    required: z.boolean().default(false),
    list: z.boolean().default(false),
    identifier: z.boolean().default(false),
    scope: name.optional(),
    // A decided field's question offers its values plus "None of these", and a choice holds at most
    // 255 options. Each value is capped like a text field's maxLength, for the same btree index.
    values: z
      .array(z.string().trim().min(1).max(600, 'Use values of 600 characters or less.'))
      .min(1)
      .max(254, 'List at most 254 values.')
      .optional(),
    // statements_current indexes value_key in a btree, whose entries hold at most 2,704 bytes. 600
    // characters, at up to 4 UTF-8 bytes each, fit there with the other columns.
    maxLength: z.number().int().min(1).max(600, 'Use a maxLength of 600 or less.').optional(),
    llm: z.boolean().default(false),
    decide: z.boolean().default(false),
    description: z.string().trim().min(1).max(300).optional(),
  })
  .transform((field): FieldDef => (field.type === 'specs' ? { ...field, list: true } : field));

const ruleSchema = z.union(
  [
    z.strictObject({
      css: z.string().trim().min(1).max(200),
      attr: z.string().trim().min(1).max(60).optional(),
    }),
    z.strictObject({ url: z.literal('canonical') }),
  ],
  { error: 'Use { css: "<selector>" } with an optional attr, or { url: canonical }.' },
);
export type Rule = z.output<typeof ruleSchema>;

const pattern = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^\/\S*$/u, 'Write a path pattern that starts with /, like /products/*.')
  // A lone surrogate passes the check above, but it is only half of a character. Matching encodes
  // every pattern, and encoding one throws.
  .refine(
    (value) => value.isWellFormed(),
    'A pattern is well-formed text, with no lone surrogate.',
  );

const evidenceSchema = z.strictObject({
  robots: isoDate,
  terms: z.strictObject({
    url: httpsUrl,
    checked: isoDate,
    automatedAccess: z.enum(['allowed', 'not-mentioned', 'forbidden']),
  }),
});

/**
 * What every kind of source has: its record type, the values it fixes or declares, and its evidence.
 * Each kind spreads these after its own fields, because problems are reported in the order of the
 * schema's keys, and a source's pages have always been reported before its evidence.
 */
const sourceFields = {
  id: slug,
  recordType: name,
  fixed: z.record(name, z.unknown()).default({}),
  extract: z.record(name, ruleSchema).default({}),
  evidence: evidenceSchema,
};

const pagesSourceSchema = z.strictObject({
  kind: z.literal('pages'),
  pages: z.array(httpsUrl).min(1).max(1000),
  ...sourceFields,
});

/**
 * A source whose pages a site's sitemaps list. Patterns match a page's path and query as
 * robots.txt's do: `*` for anything, and a final `$` for the end. A page must match an include and no
 * exclude, and at most `maxPages` of a source's pages are kept. An index's child sitemaps are read
 * when their path matches a `follow` pattern, or all of them when there is none.
 */
const sitemapSourceSchema = z.strictObject({
  kind: z.literal('sitemap'),
  sitemaps: z.array(httpsUrl).min(1).max(20),
  // Which of an index's child sitemaps to read, by path; none means all of them.
  follow: z.array(pattern).max(20).default([]),
  include: z.array(pattern).min(1).max(100),
  exclude: z.array(pattern).max(100).default([]),
  maxPages: z.number().int().min(1).max(5000).default(1000),
  // Many sitemaps stamp every entry with the time of the request, so lastmod is ignored unless the
  // owner has seen it change only when the page did.
  useLastmod: z.boolean().default(false),
  ...sourceFields,
});

const sourceSchema = z.discriminatedUnion('kind', [pagesSourceSchema, sitemapSourceSchema], {
  error: 'A source’s kind is pages or sitemap.',
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

const freshnessSchema = z.strictObject({
  maxAgeDays: z.number().int().min(1).max(365).default(7),
});

const gatesSchema = z.strictObject({
  maxRemovals: z
    .strictObject({
      count: z.number().int().min(0).max(100_000).default(25),
      share: z.number().min(0).max(1).default(0.05),
    })
    .default({ count: 25, share: 0.05 }),
});

const publicationSchema = z.strictObject({
  approval: z.enum(['auto', 'balanced', 'manual']).default('balanced'),
});

const thresholdSchema = z.strictObject({ accept: z.number().min(0.5).max(1) });

const decisionsSchema = z.strictObject({
  classify: thresholdSchema.default({ accept: 0.9 }),
  match: thresholdSchema.default({ accept: 0.95 }),
});

const budgetSchema = z.strictObject({
  itemsPerRun: z.number().int().min(1).max(3000).default(1000),
  llmTokensPerRun: z.number().int().min(0).max(50_000_000).default(2_000_000),
});

const shapeSchema = z.strictObject({
  dataset: slug,
  recordTypes: z.record(name, recordTypeSchema),
  sources: z.array(sourceSchema).min(1),
  // These defaults are functions, so each parse gets objects of its own. Zod copies only the outer
  // object of a default, and one that holds an object or an array would share it between parses.
  policy: policySchema.default(() => ({ purposes: [], perHostIntervalMs: 1000 })),
  freshness: freshnessSchema.default(() => ({ maxAgeDays: 7 })),
  gates: gatesSchema.default(() => ({ maxRemovals: { count: 25, share: 0.05 } })),
  publication: publicationSchema.default(() => ({ approval: 'balanced' as const })),
  decisions: decisionsSchema.default(() => ({
    classify: { accept: 0.9 },
    match: { accept: 0.95 },
  })),
  budget: budgetSchema.default(() => ({ itemsPerRun: 1000, llmTokensPerRun: 2_000_000 })),
  consumers: z.array(slug).max(20).default([]),
});

export const definitionSchema = shapeSchema.superRefine((definition, ctx) =>
  checkDefinition(definition, (path, message) => ctx.addIssue({ code: 'custom', path, message })),
);

export type Definition = z.output<typeof shapeSchema>;
export type RecordType = Definition['recordTypes'][string];
export type Source = Definition['sources'][number];
export type PagesSource = Extract<Source, { kind: 'pages' }>;
export type SitemapSource = Extract<Source, { kind: 'sitemap' }>;

/** The record type's field that the decision cascade may fill, if it has one. */
export function decidedField(recordType: RecordType): [string, FieldDef] | null {
  return Object.entries(recordType.fields).find(([, field]) => field.decide === true) ?? null;
}

/** A definition, with defaults filled in, or every problem with it as `path: message`. */
export function parseDefinition(
  input: unknown,
): { ok: true; definition: Definition } | { ok: false; issues: string[] } {
  const result = definitionSchema.safeParse(input);
  if (result.success) return { ok: true, definition: result.data };
  return { ok: false, issues: result.error.issues.flatMap((issue) => issueLines(issue)) };
}

/**
 * An issue as `path: message`. A record key that fails is reported by zod as "Invalid key in
 * record", and the issues inside it say what's wrong with the name, so those are what we print.
 */
function issueLines(issue: z.core.$ZodIssue, parent: PropertyKey[] = []): string[] {
  const path = [...parent, ...issue.path];
  if (issue.code === 'invalid_key') {
    return issue.issues.flatMap((inner) => issueLines(inner, path));
  }
  return [`${path.length > 0 ? path.map(String).join('.') : '(definition)'}: ${issue.message}`];
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;
// Names that only mean something inside a private network.
const PRIVATE_USE = /(?:^|\.)(?:local|internal|home\.arpa|lan)$/u;

/**
 * Why Spatula must not fetch an address, as a phrase that reads after "This address is", or `null`
 * for an address it may fetch. Definitions are checked with it, and it takes a `URL` so that the
 * fetcher can apply the same rule to each request. It judges only what the address says: a public
 * name that resolves to a private address gets through.
 */
export function addressError(url: URL): string | null {
  if (url.username !== '' || url.password !== '') return 'carrying a user name or password';
  // The URL parser keeps a trailing dot, and "localhost." is the same host as "localhost". The dots
  // are counted off one by one: a pattern such as /\.+$/ backtracks through a long run of dots
  // inside a name, in time that grows with the square of the run.
  const { hostname } = url;
  let end = hostname.length;
  while (end > 0 && hostname.charCodeAt(end - 1) === 0x2e) end -= 1;
  const host = hostname.slice(0, end);
  // The parser writes every form of an IPv4 address as a dotted quad, and an IPv6 one in brackets.
  if (host.startsWith('[') || IPV4.test(host)) return 'an IP address, not a host name';
  if (!host.includes('.') || host.endsWith('.localhost')) return 'a local name';
  if (PRIVATE_USE.test(host)) return 'a private-use name';
  return null;
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
    if (source.kind === 'pages') {
      for (const page of source.pages) {
        if (pages.has(page)) report([...at, 'pages'], `${page} is listed twice.`);
        pages.add(page);
      }
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
    if (field.decide) {
      if (field.type !== 'enum') {
        report([...path, 'decide'], 'Only enum fields can be decided.');
      } else if (!field.required) {
        report(
          [...path, 'decide'],
          'A decided field must be required: “None of these” is how a page leaves the dataset.',
        );
      }
      if (field.identifier || identifying.has(fieldName)) {
        report(
          [...path, 'decide'],
          'Fields that identify a record come from structured data or declared rules, never a decision.',
        );
      }
      // The question offers the values and “None of these”, and an answer is read back by its text.
      // A value that repeats would be offered twice. A value that is “None of these” would be
      // offered twice too, and choosing it would take a page out of the dataset, not file it.
      if (
        field.type === 'enum' &&
        field.values !== undefined &&
        (field.values.includes(NONE_OF_THESE) || new Set(field.values).size !== field.values.length)
      ) {
        report(
          [...path, 'values'],
          'A decided field’s values are distinct, and none is “None of these”.',
        );
      }
    }
  }
  if (Object.values(fields).filter((field) => field.decide).length > 1) {
    report([...at, 'fields'], 'Only one field of a record type can be decided.');
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
