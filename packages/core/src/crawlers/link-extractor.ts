import * as cheerio from 'cheerio';

const IGNORED_PROTOCOLS = ['javascript:', 'mailto:', 'tel:', 'data:', 'blob:'];

export function resolveUrl(href: string, baseUrl: string): string | null {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  for (const protocol of IGNORED_PROTOCOLS) {
    if (trimmed.toLowerCase().startsWith(protocol)) return null;
  }

  try {
    const resolved = new URL(trimmed, baseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    resolved.hash = '';
    return resolved.toString();
  } catch {
    return null;
  }
}

export interface ExtractedLink {
  url: string;
  text?: string;
  rel?: string;
}

export function extractLinks(html: string, baseUrl: string): ExtractedLink[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const links: ExtractedLink[] = [];

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;

    const resolved = resolveUrl(href, baseUrl);
    if (!resolved) return;

    if (seen.has(resolved)) return;
    seen.add(resolved);

    const text = $(el).text().trim() || undefined;
    const rel = $(el).attr('rel') || undefined;

    links.push({ url: resolved, text, rel });
  });

  return links;
}
