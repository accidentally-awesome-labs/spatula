/**
 * `spatula schema` — display the current project schema.
 *
 * Reads schema from the local DataSource and formats output to stdout.
 *
 * Flags:
 *   --versions  Show version history with field count per version
 *   --json      Output raw schema as JSON
 */

import { openLocalProject } from '../local-project.js';

// ---------------------------------------------------------------------------
// Types — mirror the shapes returned by DataSource methods
// ---------------------------------------------------------------------------

interface SchemaField {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

interface SchemaDefinition {
  version: number;
  fields: SchemaField[];
  fieldAliases: unknown[];
  createdAt: Date | string;
  parentVersion: number | null;
}

interface SchemaRecord {
  id: string;
  version: number;
  definition: SchemaDefinition;
}

interface SchemaVersionRecord {
  id: string;
  version: number;
  definition: SchemaDefinition;
  parentId: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Formatting — exported for testability
// ---------------------------------------------------------------------------

/**
 * Format a schema as a human-readable field table.
 * Returns a "no schema" message when schema is null.
 */
export function formatSchemaTable(schema: SchemaRecord | null): string {
  if (!schema) {
    return 'No schema found. Run `spatula run` to discover a schema.';
  }

  const { definition } = schema;
  const lines: string[] = [];

  lines.push(`Schema v${definition.version}  (${definition.fields.length} fields)`);
  lines.push('');

  // Compute column widths
  const nameHeader = 'Name';
  const typeHeader = 'Type';
  const reqHeader = 'Required';
  const descHeader = 'Description';

  const nameWidth = Math.max(nameHeader.length, ...definition.fields.map((f) => f.name.length));
  const typeWidth = Math.max(typeHeader.length, ...definition.fields.map((f) => f.type.length));
  const reqWidth = reqHeader.length; // "Required" is always wider than "yes"/"no"
  const descWidth = Math.max(descHeader.length, ...definition.fields.map((f) => f.description.length));

  const header = `  ${nameHeader.padEnd(nameWidth)}  ${typeHeader.padEnd(typeWidth)}  ${reqHeader.padEnd(reqWidth)}  ${descHeader.padEnd(descWidth)}`;
  const separator = `  ${'-'.repeat(nameWidth)}  ${'-'.repeat(typeWidth)}  ${'-'.repeat(reqWidth)}  ${'-'.repeat(descWidth)}`;

  lines.push(header);
  lines.push(separator);

  for (const field of definition.fields) {
    const req = field.required ? 'yes' : 'no';
    lines.push(
      `  ${field.name.padEnd(nameWidth)}  ${field.type.padEnd(typeWidth)}  ${req.padEnd(reqWidth)}  ${field.description}`,
    );
  }

  return lines.join('\n');
}

/**
 * Format schema version history as a human-readable table.
 * Returns a "no versions" message when array is empty.
 */
export function formatVersionHistory(versions: SchemaVersionRecord[]): string {
  if (versions.length === 0) {
    return 'No schema versions found. Run `spatula run` to discover a schema.';
  }

  const lines: string[] = [];
  lines.push(`Schema History  (${versions.length} version${versions.length === 1 ? '' : 's'})`);
  lines.push('');

  // Build a map of version → field names for diff computation
  const versionFieldMap = new Map<number, Set<string>>();
  for (const v of versions) {
    versionFieldMap.set(v.version, new Set(v.definition.fields.map((f) => f.name)));
  }

  function computeDiff(ver: SchemaVersionRecord): string {
    if (ver.definition.parentVersion == null) return '(initial)';
    const parentFields = versionFieldMap.get(ver.definition.parentVersion);
    if (!parentFields) return '';
    const currentFields = new Set(ver.definition.fields.map((f) => f.name));
    const added = [...currentFields].filter((f) => !parentFields.has(f));
    const removed = [...parentFields].filter((f) => !currentFields.has(f));
    const parts: string[] = [];
    if (added.length > 0) parts.push(`+${added.length} field${added.length > 1 ? 's' : ''}`);
    if (removed.length > 0) parts.push(`-${removed.length} field${removed.length > 1 ? 's' : ''}`);
    return parts.length > 0 ? parts.join(', ') : 'no changes';
  }

  const versionHeader = 'Version';
  const fieldsHeader = 'Fields';
  const diffHeader = 'Changes';
  const createdHeader = 'Created At';

  const diffs = versions.map(computeDiff);
  const versionWidth = Math.max(versionHeader.length, ...versions.map((v) => `v${v.version}`.length));
  const fieldsWidth = Math.max(fieldsHeader.length, ...versions.map((v) => String(v.definition.fields.length).length));
  const diffWidth = Math.max(diffHeader.length, ...diffs.map((d) => d.length));
  const createdWidth = Math.max(createdHeader.length, ...versions.map((v) => v.createdAt.length));

  const header = `  ${versionHeader.padEnd(versionWidth)}  ${fieldsHeader.padEnd(fieldsWidth)}  ${diffHeader.padEnd(diffWidth)}  ${createdHeader.padEnd(createdWidth)}`;
  const separator = `  ${'-'.repeat(versionWidth)}  ${'-'.repeat(fieldsWidth)}  ${'-'.repeat(diffWidth)}  ${'-'.repeat(createdWidth)}`;

  lines.push(header);
  lines.push(separator);

  for (let i = 0; i < versions.length; i++) {
    const ver = versions[i];
    const v = `v${ver.version}`;
    const fields = String(ver.definition.fields.length);
    lines.push(
      `  ${v.padEnd(versionWidth)}  ${fields.padEnd(fieldsWidth)}  ${diffs[i].padEnd(diffWidth)}  ${ver.createdAt}`,
    );
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Command runner
// ---------------------------------------------------------------------------

export async function runSchemaCommand(opts: {
  versions?: boolean;
  json?: boolean;
}): Promise<void> {
  const project = await openLocalProject(process.cwd());

  try {
    if (opts.versions) {
      const versions = (await project.dataSource.getSchemaVersions()) as SchemaVersionRecord[];
      if (opts.json) {
        console.log(JSON.stringify(versions, null, 2));
      } else {
        console.log(formatVersionHistory(versions));
      }
    } else {
      const schema = (await project.dataSource.getSchema()) as SchemaRecord | null;
      if (opts.json) {
        console.log(JSON.stringify(schema, null, 2));
      } else {
        console.log(formatSchemaTable(schema));
      }
    }
  } finally {
    project.close();
  }
}
