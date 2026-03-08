import { describe, it, expect } from 'vitest';
import * as interfaces from '../../../src/interfaces/index.js';

describe('core interfaces are exported', () => {
  const expectedExports = [
    'CrawlResult',
    'CrawlOptions',
    'ExportOptions',
    'ExportResult',
    'ExportFormat',
    'ActionResult',
    'ActionPreview',
    'StateChange',
    'ConfigValidationResult',
    'ConfigDiff',
  ];

  for (const name of expectedExports) {
    it(`exports ${name}`, () => {
      expect((interfaces as Record<string, unknown>)[name]).toBeDefined();
    });
  }
});
