import * as cheerio from 'cheerio';
import { generateId } from '@spatula/shared';
import type { Extractor } from '../interfaces/extractor.js';
import type { SchemaDefinition, FieldDefinition } from '../types/schema.js';
import type { ExtractionResult } from '../types/extraction.js';

export class CssExtractor implements Extractor {
  async extract(
    html: string,
    url: string,
    schema: SchemaDefinition,
    _jobDescription: string,
  ): Promise<ExtractionResult> {
    const $ = cheerio.load(html);
    const data: Record<string, unknown> = {};
    let matchCount = 0;

    if (schema.fields.length > 0) {
      for (const field of schema.fields) {
        const value = extractByField($, field, url);
        if (value !== null && value !== undefined) {
          data[field.name] = value;
          matchCount++;
        }
      }
    } else {
      const discovered = autoDiscover($, url);
      Object.assign(data, discovered);
      matchCount = Object.keys(discovered).length;
    }

    const totalFields = Math.max(schema.fields.length, 1);
    const confidence = Math.min(matchCount / totalFields, 1) * 0.6;

    return {
      id: generateId(),
      jobId: generateId(),
      pageId: generateId(),
      schemaVersion: schema.version,
      data,
      metadata: {
        confidence,
        modelUsed: 'css-extractor',
        tokensUsed: 0,
        extractionTimeMs: 0,
        unmappedFields: [],
      },
    };
  }
}

const PRICE_PATTERN = /[$€£¥₹]\s*[\d,]+\.?\d*/;
const NUMBER_PATTERN = /^[\d,]+\.?\d*$/;

function extractByField($: cheerio.CheerioAPI, field: FieldDefinition, baseUrl: string): unknown {
  const nameLower = field.name.toLowerCase();
  switch (field.type) {
    case 'currency':
      return findPrice($);
    case 'url':
      return findUrl($, nameLower, baseUrl);
    case 'number':
      return findNumber($, nameLower);
    case 'array':
      if (field.arrayItemType?.type === 'object' || field.objectFields) {
        return findTable($, nameLower);
      }
      return findList($, nameLower);
    case 'string':
    default:
      return findText($, nameLower);
  }
}

function findPrice($: cheerio.CheerioAPI): string | null {
  const priceSelectors = [
    '[class*="price"]',
    '[class*="cost"]',
    '[class*="amount"]',
    '[data-price]',
    '[itemprop="price"]',
  ];
  for (const sel of priceSelectors) {
    const el = $(sel).first();
    if (el.length) {
      const text = el.text().trim();
      const match = text.match(PRICE_PATTERN);
      if (match) return match[0];
    }
  }
  let found: string | null = null;
  $('body *').each((_, el) => {
    if (found) return;
    const text = $(el).text().trim();
    const match = text.match(PRICE_PATTERN);
    if (match) found = match[0];
  });
  return found;
}

function findUrl($: cheerio.CheerioAPI, fieldName: string, baseUrl: string): string | null {
  if (/image|photo|picture|thumbnail|avatar|logo|img/i.test(fieldName)) {
    const img = $('img[src]').first();
    if (img.length) return resolveUrl(img.attr('src')!, baseUrl);
    const ogImage = $('meta[property="og:image"]').attr('content');
    if (ogImage) return resolveUrl(ogImage, baseUrl);
  }
  if (/link|href|url|website|homepage/i.test(fieldName)) {
    const link = $('a[href]').not('[href^="#"]').not('[href^="javascript"]').first();
    if (link.length) return resolveUrl(link.attr('href')!, baseUrl);
  }
  const img = $('article img[src], main img[src], .content img[src]').first();
  if (img.length) return resolveUrl(img.attr('src')!, baseUrl);
  const link = $('a[href^="http"]').first();
  if (link.length) return link.attr('href')!;
  return null;
}

function findNumber($: cheerio.CheerioAPI, fieldName: string): number | null {
  const selectors = [`[class*="${fieldName}"]`, `[data-${fieldName}]`, `[itemprop="${fieldName}"]`];
  for (const sel of selectors) {
    const text = $(sel).first().text().trim();
    const cleaned = text.replace(/[^0-9.,]/g, '');
    if (NUMBER_PATTERN.test(cleaned)) return parseFloat(cleaned.replace(/,/g, ''));
  }
  return null;
}

function findText($: cheerio.CheerioAPI, fieldName: string): string | null {
  const attrSelectors = [`[class*="${fieldName}"]`, `[itemprop="${fieldName}"]`, `#${fieldName}`];
  for (const sel of attrSelectors) {
    try {
      const el = $(sel).first();
      if (el.length) {
        const text = el.text().trim();
        if (text) return text;
      }
    } catch {
      /* skip */
    }
  }
  if (/title|name|heading|headline/i.test(fieldName)) {
    const h1 = $('h1').first().text().trim();
    if (h1) return h1;
    const h2 = $('h2').first().text().trim();
    if (h2) return h2;
  }
  if (/description|summary|excerpt|about|overview/i.test(fieldName)) {
    const metaDesc = $('meta[name="description"]').attr('content');
    if (metaDesc) return metaDesc;
    const p = $('article p, main p, .content p').first().text().trim();
    if (p) return p;
  }
  return null;
}

function findList($: cheerio.CheerioAPI, fieldName: string): string[] | null {
  // Priority 1: lists with matching class
  const classMatch = $(`[class*="${fieldName}"] li`).slice(0, 20);
  if (classMatch.length > 0) {
    const items = classMatch
      .map((_, el) => $(el).text().trim())
      .get()
      .filter(Boolean);
    if (items.length > 0) return items;
  }
  // Priority 2: generic lists (only as fallback)
  const generic = $('ul li, ol li').slice(0, 20);
  if (generic.length > 0) {
    const items = generic
      .map((_, el) => $(el).text().trim())
      .get()
      .filter(Boolean);
    if (items.length > 0) return items;
  }
  return null;
}

function findTable($: cheerio.CheerioAPI, fieldName: string): Array<Record<string, string>> | null {
  const selectors: string[] = [];
  if (fieldName) {
    selectors.push(`table[class*="${fieldName}"]`, `table[id*="${fieldName}"]`);
  }
  selectors.push('article table', 'main table', '.content table', 'table');

  let table: ReturnType<typeof $> | null = null;
  for (const sel of selectors) {
    const found = $(sel).first();
    if (found.length && found.find('tr').length >= 2) {
      table = found;
      break;
    }
  }
  if (!table) return null;

  let headers: string[] = [];
  const theadCells = table.find('thead th, thead td');
  if (theadCells.length > 0) {
    headers = theadCells.map((_, el) => $(el).text().trim()).get();
  } else {
    const firstRow = table.find('tr').first();
    headers = firstRow
      .find('th, td')
      .map((_, el) => $(el).text().trim())
      .get();
  }
  if (headers.length === 0) return null;

  const bodyRows = theadCells.length > 0 ? table.find('tbody tr') : table.find('tr').slice(1);

  const rows: Array<Record<string, string>> = [];
  // Track rowspan carry-overs: { colIdx: { value, remaining } }
  const rowspanState: Map<number, { value: string; remaining: number }> = new Map();

  bodyRows.each((_, row) => {
    const record: Record<string, string> = {};
    let colIdx = 0;
    $(row)
      .find('th, td')
      .each((_, cell) => {
        // Skip columns occupied by rowspan from previous rows
        while (rowspanState.has(colIdx) && colIdx < headers.length) {
          const rs = rowspanState.get(colIdx)!;
          record[headers[colIdx]] = rs.value;
          rs.remaining--;
          if (rs.remaining <= 0) rowspanState.delete(colIdx);
          colIdx++;
        }

        const text = $(cell).text().trim();
        const colspan = parseInt($(cell).attr('colspan') ?? '1', 10);
        const rowspan = parseInt($(cell).attr('rowspan') ?? '1', 10);

        for (let i = 0; i < colspan && colIdx < headers.length; i++) {
          record[headers[colIdx]] = text;
          if (rowspan > 1) {
            rowspanState.set(colIdx, { value: text, remaining: rowspan - 1 });
          }
          colIdx++;
        }
      });
    // Fill any remaining rowspan columns at end of row
    while (rowspanState.has(colIdx) && colIdx < headers.length) {
      const rs = rowspanState.get(colIdx)!;
      record[headers[colIdx]] = rs.value;
      rs.remaining--;
      if (rs.remaining <= 0) rowspanState.delete(colIdx);
      colIdx++;
    }

    if (Object.values(record).some((v) => v !== '')) {
      rows.push(record);
    }
  });

  return rows.length > 0 ? rows : null;
}

function autoDiscover($: cheerio.CheerioAPI, baseUrl: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const h1 = $('h1').first().text().trim();
  if (h1) data.title = h1;
  const h2 = $('h2').first().text().trim();
  if (h2 && h2 !== h1) data.subtitle = h2;
  const metaDesc = $('meta[name="description"]').attr('content');
  if (metaDesc) data.description = metaDesc;
  const mainImg = $('article img[src], main img[src], img[src]').first();
  if (mainImg.length) data.image = resolveUrl(mainImg.attr('src')!, baseUrl);
  if (!data.image) {
    const ogImage = $('meta[property="og:image"]').attr('content');
    if (ogImage) data.image = resolveUrl(ogImage, baseUrl);
  }
  const price = findPrice($);
  if (price) data.price = price;
  const links = $('article a[href], main a[href], .content a[href]')
    .not('[href^="#"]')
    .not('[href^="javascript"]')
    .slice(0, 5)
    .map((_, el) => ({ text: $(el).text().trim(), href: resolveUrl($(el).attr('href')!, baseUrl) }))
    .get()
    .filter((l) => l.text);
  if (links.length > 0) data.links = links;
  // Tables — require 3+ data rows to avoid extracting layout/nav tables
  const tableData = findTable($, '');
  if (tableData && tableData.length >= 3) {
    data.tables = tableData;
  }
  return data;
}

function resolveUrl(href: string, baseUrl: string): string {
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return href;
  }
}
