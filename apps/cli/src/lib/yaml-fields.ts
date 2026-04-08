// apps/cli/src/lib/yaml-fields.ts

interface FieldEntry {
  name: string;
  type: string;
  required?: boolean;
}

export function appendFieldsToYaml(
  yamlContent: string,
  fields: FieldEntry[],
  date: string,
): string {
  if (fields.length === 0) return yamlContent;

  const comment = `  # Discovered by remote crawl (${date}):`;
  const fieldLines = fields.map((f) => {
    if (f.required && f.type !== 'string') {
      return `  - field: ${f.name}\n    type: ${f.type}\n    required: true`;
    }
    return `  - ${f.name}: ${f.type}`;
  });
  const block = `${comment}\n${fieldLines.join('\n')}\n`;

  // Handle "fields: []" — replace with populated block
  const emptyArrayMatch = yamlContent.match(/^(fields:\s*\[\])/m);
  if (emptyArrayMatch) {
    const idx = yamlContent.indexOf(emptyArrayMatch[0]);
    const before = yamlContent.slice(0, idx);
    const after = yamlContent.slice(idx + emptyArrayMatch[0].length);
    return `${before}fields:\n${block}${after}`;
  }

  // Find last field entry in existing fields block
  const fieldsHeaderMatch = yamlContent.match(/^fields:\s*$/m);
  if (fieldsHeaderMatch) {
    const lines = yamlContent.split('\n');
    let lastFieldLineIdx = -1;
    let inFieldsBlock = false;

    for (let i = 0; i < lines.length; i++) {
      if (/^fields:\s*$/.test(lines[i])) {
        inFieldsBlock = true;
        continue;
      }
      if (inFieldsBlock) {
        if (/^\s+-/.test(lines[i]) || /^\s+\w/.test(lines[i])) {
          lastFieldLineIdx = i;
        } else if (/^\S/.test(lines[i])) {
          break;
        }
      }
    }

    if (lastFieldLineIdx >= 0) {
      const before = lines.slice(0, lastFieldLineIdx + 1).join('\n');
      const after = lines.slice(lastFieldLineIdx + 1).join('\n');
      return `${before}\n${block}${after}`;
    }
    const idx = yamlContent.indexOf(fieldsHeaderMatch[0]);
    const insertAt = idx + fieldsHeaderMatch[0].length;
    return `${yamlContent.slice(0, insertAt)}\n${block}${yamlContent.slice(insertAt)}`;
  }

  // No fields block — append one before depth/limit or at end
  const insertBeforeMatch = yamlContent.match(/^(depth|limit|crawler|safety|crawl|schema|llm):/m);
  if (insertBeforeMatch) {
    const idx = yamlContent.indexOf(insertBeforeMatch[0]);
    return `${yamlContent.slice(0, idx)}fields:\n${block}\n${yamlContent.slice(idx)}`;
  }

  return `${yamlContent.trimEnd()}\n\nfields:\n${block}`;
}
