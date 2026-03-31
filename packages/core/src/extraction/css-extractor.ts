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
    case 'currency': return findPrice($);
    case 'url': return findUrl($, nameLower, baseUrl);
    case 'number': return findNumber($, nameLower);
    case 'array': return findList($, nameLower);
    case 'string': default: return findText($, nameLower);
  }
}

function findPrice($: cheerio.CheerioAPI): string | null {
  const priceSelectors = ['[class*="price"]', '[class*="cost"]', '[class*="amount"]', '[data-price]', '[itemprop="price"]'];
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
    } catch { /* skip */ }
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
  const list = $(`[class*="${fieldName}"] li, ul li, ol li`).slice(0, 20);
  if (list.length > 0) {
    const items = list.map((_, el) => $(el).text().trim()).get().filter(Boolean);
    if (items.length > 0) return items;
  }
  return null;
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
  return data;
}

function resolveUrl(href: string, baseUrl: string): string {
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return href;
  }
}
