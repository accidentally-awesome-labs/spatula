import * as cheerio from 'cheerio';

export interface PreprocessedHTML {
  content: string;
  title?: string;
  estimatedTokens: number;
  truncated: boolean;
}

export interface PreprocessOptions {
  maxTokens?: number;
}

const REMOVE_TAGS = 'script, style, noscript, svg, iframe, canvas, [hidden]';
const SEMANTIC_CLASS_RE =
  /(?:rating|rated|star|score|price|amount|currency|availability|stock|status|product|sku|title|name|review|badge|label|sale|sold|category|brand)/i;
const RATING_WORD_RE = /^(?:zero|one|two|three|four|five|0|1|2|3|4|5)$/i;
const SEMANTIC_ATTR_RE =
  /(?:rating|rated|star|score|price|amount|currency|availability|stock|status|product|sku|title|name|review|brand|category|url|href|link|id|content)/i;

export function preprocessHTML(html: string, options?: PreprocessOptions): PreprocessedHTML {
  const maxChars = (options?.maxTokens ?? 25000) * 4;
  const $ = cheerio.load(html);

  $(REMOVE_TAGS).remove();

  const title = $('title').first().text().trim() || $('h1').first().text().trim() || undefined;

  const body = $('body');
  const raw = body.length ? walkNode($, body[0]) : '';

  const cleaned = raw
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const truncated = cleaned.length > maxChars;
  const finalContent = truncated ? cleaned.slice(0, maxChars) + '\n[...truncated]' : cleaned;

  return {
    content: finalContent,
    title,
    estimatedTokens: finalContent.length ? Math.ceil(finalContent.length / 4) : 0,
    truncated,
  };
}

function walkNode($: cheerio.CheerioAPI, node: unknown): string {
  const n = node as { type?: string; data?: string; tagName?: string; name?: string };

  if (n.type === 'text') {
    return n.data ?? '';
  }

  if (n.type !== 'tag') return '';

  const tag = (n.tagName ?? n.name ?? '').toLowerCase();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const $el = $(node as any);
  const metadata = describeElementMetadata($el, tag);
  const children = $el
    .contents()
    .toArray()
    .map((child) => walkNode($, child))
    .join('');

  switch (tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      const level = Number(tag[1]);
      return `\n${'#'.repeat(level >= 1 && level <= 6 ? level : 1)} ${withMetadata(children.trim(), metadata)}\n`;
    case 'p':
      return `\n${withMetadata(children.trim(), metadata)}\n`;
    case 'li':
      return `\n- ${withMetadata(children.trim(), metadata)}`;
    case 'ul':
    case 'ol':
      return `\n${children}\n`;
    case 'img':
      return withMetadata('', metadata);
    case 'br':
      return '\n';
    case 'tr': {
      const cells = $el
        .children('td, th')
        .map((_, td) => walkNode($, td).trim() || $(td).text().trim())
        .get();
      return cells.length ? `\n${cells.join(' | ')}` : children;
    }
    case 'table':
    case 'thead':
    case 'tbody':
      return `\n${children}\n`;
    case 'div':
    case 'section':
    case 'article':
    case 'main':
    case 'aside':
      return `\n${withMetadata(children, metadata)}\n`;
    case 'a':
      return withMetadata(children.trim(), metadata);
    default:
      return withMetadata(children, metadata);
  }
}

function withMetadata(content: string, metadata: string[]): string {
  const cleanContent = content.trim();
  if (metadata.length === 0) return cleanContent;
  const annotation = `[${metadata.join('; ')}]`;
  return cleanContent ? `${cleanContent} ${annotation}` : annotation;
}

function describeElementMetadata(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $el: cheerio.Cheerio<any>,
  tag: string,
): string[] {
  const attrs = ($el.attr() ?? {}) as Record<string, string>;
  const metadata: string[] = [];

  addAttr(metadata, attrs, 'aria-label');
  addAttr(metadata, attrs, 'title');
  addAttr(metadata, attrs, 'itemprop');
  addAttr(metadata, attrs, 'content');

  if (tag === 'a') {
    addAttr(metadata, attrs, 'href');
  }

  if (tag === 'img') {
    addAttr(metadata, attrs, 'alt');
    addAttr(metadata, attrs, 'src');
  }

  for (const [name, value] of Object.entries(attrs)) {
    if (!name.startsWith('data-')) continue;
    if (!SEMANTIC_ATTR_RE.test(name)) continue;
    addMetadata(metadata, name, value);
  }

  const classSummary = summarizeSemanticClasses(attrs['class']);
  if (classSummary) {
    metadata.push(`class: ${classSummary}`);
  }

  return dedupe(metadata);
}

function addAttr(metadata: string[], attrs: Record<string, string>, name: string): void {
  addMetadata(metadata, name, attrs[name]);
}

function addMetadata(metadata: string[], name: string, value: unknown): void {
  if (typeof value !== 'string') return;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (!cleaned) return;
  metadata.push(`${name}: ${cleaned.slice(0, 200)}`);
}

function summarizeSemanticClasses(classValue: string | undefined): string | null {
  if (!classValue) return null;
  const tokens = classValue.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const hasSemanticClass = tokens.some((token) => SEMANTIC_CLASS_RE.test(token));
  const hasRatingWord = tokens.some((token) => RATING_WORD_RE.test(token));
  const hasRatingContext = tokens.some((token) => /(?:rating|rated|star|score)/i.test(token));

  if (!hasSemanticClass && !(hasRatingContext && hasRatingWord)) return null;

  return tokens.slice(0, 12).join(' ');
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
