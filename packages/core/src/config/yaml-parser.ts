import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { ValidationError } from '@accidentally-awesome-labs/spatula-shared';
import { SpatulaYamlSchema } from './types.js';
import type { SpatulaYaml, YamlFieldShorthand } from './types.js';
import type { FieldDefinitionInput } from '../types/schema.js';

/**
 * Expand a field shorthand entry into a full FieldDefinition.
 *
 * Shorthand: { product_name: "string" } → { name, type, description, required }
 * Expanded:  { field: "price", type: "currency", required: true } → { name, type, description, required }
 *
 * Note: `selector` from the expanded form is intentionally NOT mapped to
 * FieldDefinitionInput (no selector field on that type). It's a YAML-only
 * convenience for CSS-selector-based extraction hints.
 */
export function expandFieldShorthand(entry: YamlFieldShorthand): FieldDefinitionInput {
  // Expanded form: has 'field' key
  if ('field' in entry && typeof entry.field === 'string') {
    const expanded = entry as {
      field: string;
      type: FieldDefinitionInput['type'];
      required?: boolean;
      selector?: string;
      description?: string;
    };
    return {
      name: expanded.field,
      type: expanded.type,
      description: expanded.description ?? expanded.field,
      required: expanded.required ?? false,
    };
  }

  // Shorthand form: single key-value pair like { product_name: "string" }
  const keys = Object.keys(entry);
  if (keys.length === 1) {
    const name = keys[0];
    const type = (entry as Record<string, string>)[name];
    return {
      name,
      type: type as FieldDefinitionInput['type'],
      description: name,
      required: false,
    };
  }

  throw new ValidationError(`Invalid field definition: ${JSON.stringify(entry)}`);
}

/**
 * Parse a spatula.yaml string into a validated SpatulaYaml object.
 * Throws ValidationError on invalid config.
 */
export function parseProjectYaml(content: string): SpatulaYaml {
  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (err) {
    throw new ValidationError(`Invalid YAML syntax: ${(err as Error).message}`);
  }

  if (raw === null || raw === undefined) {
    throw new ValidationError('Empty spatula.yaml file');
  }

  const result = SpatulaYamlSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new ValidationError(`Invalid spatula.yaml: ${issues}`);
  }

  return result.data;
}

/**
 * Parse a spatula.yaml file from disk.
 */
export function parseProjectYamlFile(filePath: string): SpatulaYaml {
  const content = readFileSync(filePath, 'utf-8');
  return parseProjectYaml(content);
}
