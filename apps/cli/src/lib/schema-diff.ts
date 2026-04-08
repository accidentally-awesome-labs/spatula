// apps/cli/src/lib/schema-diff.ts

interface FieldDef {
  name: string;
  description: string;
  type: string;
  required: boolean;
  [key: string]: unknown;
}

interface SchemaLike {
  version: number;
  fields: FieldDef[];
  [key: string]: unknown;
}

export interface SchemaDiff {
  localOnly: FieldDef[];
  remoteOnly: FieldDef[];
  changed: Array<{
    name: string;
    local: FieldDef;
    remote: FieldDef;
    differences: string[];
  }>;
  unchanged: FieldDef[];
  hasChanges: boolean;
}

export function diffSchemas(local: SchemaLike, remote: SchemaLike): SchemaDiff {
  const localMap = new Map(local.fields.map((f) => [f.name, f]));
  const remoteMap = new Map(remote.fields.map((f) => [f.name, f]));

  const localOnly: FieldDef[] = [];
  const remoteOnly: FieldDef[] = [];
  const changed: SchemaDiff['changed'] = [];
  const unchanged: FieldDef[] = [];

  for (const [name, lf] of localMap) {
    const rf = remoteMap.get(name);
    if (!rf) {
      localOnly.push(lf);
    } else {
      const diffs = fieldDifferences(lf, rf);
      if (diffs.length > 0) {
        changed.push({ name, local: lf, remote: rf, differences: diffs });
      } else {
        unchanged.push(lf);
      }
    }
  }

  for (const [name, rf] of remoteMap) {
    if (!localMap.has(name)) {
      remoteOnly.push(rf);
    }
  }

  return {
    localOnly,
    remoteOnly,
    changed,
    unchanged,
    hasChanges: localOnly.length > 0 || remoteOnly.length > 0 || changed.length > 0,
  };
}

function fieldDifferences(local: FieldDef, remote: FieldDef): string[] {
  const diffs: string[] = [];
  if (local.type !== remote.type) {
    diffs.push(`type: ${local.type} → ${remote.type}`);
  }
  if (local.required !== remote.required) {
    diffs.push(`required: ${local.required} → ${remote.required}`);
  }
  return diffs;
}
