import type { FieldDefinitionOutput } from '../types/schema.js';

export function schemaToPrompt(fields: FieldDefinitionOutput[]): string {
  return fields.map((f) => fieldToLine(f, 0)).join('\n');
}

function fieldToLine(field: FieldDefinitionOutput, indent: number): string {
  const prefix = '  '.repeat(indent);
  const req = field.required ? ' (REQUIRED)' : '';

  let typeStr = field.type as string;
  if (field.type === 'enum' && field.enumValues?.length) {
    typeStr = `enum: ${field.enumValues.map((v) => `"${v}"`).join(', ')}`;
  }
  if (field.type === 'array' && field.arrayItemType) {
    typeStr = `array of ${field.arrayItemType.type}`;
  }

  let line = `${prefix}- ${field.name} (${typeStr}${req}): ${field.description}`;

  if (field.type === 'object' && field.objectFields?.length) {
    const subLines = field.objectFields.map((f) => fieldToLine(f, indent + 1));
    line += '\n' + subLines.join('\n');
  }

  return line;
}

type JsonSchemaProperty = {
  type: string;
  description?: string;
  enum?: string[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
};

export function schemaToJsonSchema(
  fields: FieldDefinitionOutput[],
): JsonSchemaProperty & { required: string[] } {
  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];

  for (const field of fields) {
    properties[field.name] = fieldToJsonSchema(field);
    if (field.required) {
      required.push(field.name);
    }
  }

  return { type: 'object', properties, required };
}

function fieldToJsonSchema(field: FieldDefinitionOutput): JsonSchemaProperty {
  switch (field.type) {
    case 'string':
    case 'url':
      return { type: 'string', description: field.description };
    case 'number':
      return { type: 'number', description: field.description };
    case 'boolean':
      return { type: 'boolean', description: field.description };
    case 'currency':
      return {
        type: 'object',
        description: field.description,
        properties: {
          amount: { type: 'number' },
          currency: { type: 'string' },
        },
      };
    case 'enum':
      return {
        type: 'string',
        description: field.description,
        enum: field.enumValues ?? [],
      };
    case 'array': {
      const items = field.arrayItemType
        ? fieldToJsonSchema(field.arrayItemType)
        : { type: 'string' };
      return { type: 'array', description: field.description, items };
    }
    case 'object': {
      const props: Record<string, JsonSchemaProperty> = {};
      const req: string[] = [];
      for (const sub of field.objectFields ?? []) {
        props[sub.name] = fieldToJsonSchema(sub);
        if (sub.required) req.push(sub.name);
      }
      return {
        type: 'object',
        description: field.description,
        properties: props,
        ...(req.length ? { required: req } : {}),
      };
    }
    default:
      return { type: 'string', description: field.description };
  }
}
