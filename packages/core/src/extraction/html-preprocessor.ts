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
  const n = node as { type?: string; data?: string; tagName?: string };

  if (n.type === 'text') {
    return n.data ?? '';
  }

  if (n.type !== 'tag') return '';

  const tag = n.tagName?.toLowerCase() ?? '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const $el = $(node as any);
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
      return `\n${'#'.repeat(level >= 1 && level <= 6 ? level : 1)} ${children.trim()}\n`;
    case 'p':
      return `\n${children.trim()}\n`;
    case 'li':
      return `\n- ${children.trim()}`;
    case 'ul':
    case 'ol':
      return `\n${children}\n`;
    case 'br':
      return '\n';
    case 'tr': {
      const cells = $el
        .children('td, th')
        .map((_, td) => $(td).text().trim())
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
      return `\n${children}\n`;
    default:
      return children;
  }
}
