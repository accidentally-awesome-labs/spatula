import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { SpatulaYamlSchema } from '../../../src/config/types.js';

const EXAMPLES_DIR = join(__dirname, '..', '..', '..', '..', '..', 'examples');

const examples = ['quickstart', 'ecommerce', 'news', 'real-estate'];

describe('example configurations', () => {
  for (const example of examples) {
    it(`examples/${example}/spatula.yaml passes schema validation`, () => {
      const raw = readFileSync(join(EXAMPLES_DIR, example, 'spatula.yaml'), 'utf-8');
      const parsed = parse(raw);
      const result = SpatulaYamlSchema.safeParse(parsed);
      if (!result.success) {
        throw new Error(
          `examples/${example}/spatula.yaml failed validation:\n${result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`,
        );
      }
    });
  }
});
