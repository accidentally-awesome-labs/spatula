import { selectOne } from 'css-select';
import { isTag, isText, type AnyNode, type Element } from 'domhandler';
import { DomUtils, parseDocument } from 'htmlparser2';

/*
 * A fetched HTML page, read once: its JSON-LD, meta tags, canonical address, and main text, and
 * a way to run a rule a person declared. All of it is evidence. Nothing in a page can change
 * what Spatula does.
 */

export type JsonLdNode = Record<string, unknown>;

export interface Page {
  /** The address the page came from, after redirects. */
  url: string;
  /** The page's own https address on the same host, from <link rel="canonical">, or `url`. */
  canonicalUrl: string;
  /**
   * Every JSON-LD object with an @type, in document order, with @graph and mainEntity members
   * spread out.
   */
  jsonLd: JsonLdNode[];
  /** How many JSON-LD blocks couldn't be read as JSON. */
  jsonLdErrors: number;
  /** Meta tags' content by property or name, lowercased, in document order. */
  meta: Map<string, string[]>;
  /** The main text on one line, without scripts, styles, or (outside <main>) navigation. */
  text: string;
  /** The text of the first element a CSS selector matches, or its attribute; `null` if none. */
  select(css: string, attribute?: string): string | null;
}

/** The most text a page gives the LLM: about 15,000 tokens. */
export const PAGE_TEXT_MAX = 60_000;

/**
 * The deepest a page may nest its elements. Real product pages nest a few dozen deep. htmlparser2
 * takes time that grows with the square of the depth, and a Worker can't catch running out of CPU,
 * so a page past this is refused before it's parsed.
 */
export const MAX_NESTING = 10_000;

/** Elements that never contain others. */
const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'keygen',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/**
 * Elements whose end tag may be left out. The parser closes one when a sibling starts, so however
 * many are open, they don't deepen the tree.
 */
const OPTIONAL_END = new Set([
  'p',
  'li',
  'dt',
  'dd',
  'tr',
  'td',
  'th',
  'option',
  'optgroup',
  'rb',
  'rt',
  'rtc',
  'rp',
  'thead',
  'tbody',
  'tfoot',
  'colgroup',
  'caption',
]);

/** Elements whose content is text, not markup: a "<" inside them opens nothing. */
const RAW_TEXT = new Set([
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
  'plaintext',
  'noembed',
  'noframes',
  'iframe',
]);

/**
 * How deeply a page's elements nest, read in one pass over its text. It's an estimate, good enough
 * to refuse a hostile page: an element left open counts as open (except those whose end tags may be
 * left out), and a ">" inside an attribute's value can end a tag early. Each tag's name is read from
 * at most 64 characters, so the pass stays linear however long a tag is.
 */
export function nestingDepth(markup: string): number {
  const lower = markup.toLowerCase();
  let depth = 0;
  let deepest = 0;
  let at = 0;
  for (;;) {
    const open = lower.indexOf('<', at);
    if (open === -1) return deepest;
    if (lower.startsWith('<!--', open)) {
      const end = lower.indexOf('-->', open + 4);
      if (end === -1) return deepest;
      at = end + 3;
      continue;
    }
    const close = lower.indexOf('>', open + 1);
    if (close === -1) return deepest;
    at = close + 1;
    const ending = lower.charCodeAt(open + 1) === 0x2f;
    const start = open + (ending ? 2 : 1);
    const name = /^[a-z][a-z0-9:-]*/u.exec(lower.slice(start, Math.min(close, start + 64)))?.[0];
    if (name === undefined || VOID_ELEMENTS.has(name) || OPTIONAL_END.has(name)) continue;
    if (ending) {
      if (depth > 0) depth -= 1;
      continue;
    }
    // A self-closed tag, such as <svg/>, opens nothing.
    if (lower.charCodeAt(close - 1) === 0x2f) continue;
    depth += 1;
    if (depth > deepest) deepest = depth;
    if (RAW_TEXT.has(name)) {
      // Jump to its end tag, which the next pass reads as the element closing.
      const end = lower.indexOf(`</${name}`, at);
      at = end === -1 ? lower.length : end;
    }
  }
}

const NEVER_TEXT = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'head']);
const CHROME = new Set(['nav', 'header', 'footer']);
const SCHEMA_PREFIX = /^(?:https?:\/\/schema\.org\/|schema:)/u;

export function parsePage(html: string, url: string): Page {
  const depth = nestingDepth(html);
  if (depth > MAX_NESTING) {
    throw new Error(
      `the page nests elements ${depth.toLocaleString('en-US')} deep, more than ${MAX_NESTING.toLocaleString('en-US')}`,
    );
  }
  const document = parseDocument(html);
  const elements = (tag: string) => DomUtils.getElementsByTagName(tag, document, true);

  const jsonLd: JsonLdNode[] = [];
  let jsonLdErrors = 0;
  for (const script of elements('script')) {
    const type = (script.attribs.type ?? '').split(';')[0]?.trim().toLowerCase();
    if (type !== 'application/ld+json') continue;
    const parsed = parseJson(DomUtils.textContent(script));
    if (parsed === undefined) jsonLdErrors += 1;
    else collectNodes(parsed, jsonLd, 0);
  }

  const meta = new Map<string, string[]>();
  for (const tag of elements('meta')) {
    const key = (tag.attribs.property ?? tag.attribs.name ?? '').trim().toLowerCase();
    const content = tag.attribs.content;
    if (key === '' || content === undefined) continue;
    const values = meta.get(key);
    if (values === undefined) meta.set(key, [content.trim()]);
    else values.push(content.trim());
  }

  return {
    url,
    canonicalUrl: canonical(elements('link'), url),
    jsonLd,
    jsonLdErrors,
    meta,
    text: mainText(elements('main')[0] ?? elements('body')[0] ?? null, document.children),
    select(css, attribute) {
      const element = selectOne<AnyNode, Element>(css, document);
      if (element === null) return null;
      const value =
        attribute === undefined ? DomUtils.textContent(element) : attributeOf(element, attribute);
      const text = value?.replace(/\s+/gu, ' ').trim() ?? '';
      return text === '' ? null : text;
    },
  };
}

/** The types a JSON-LD object declares, without schema.org prefixes. */
export function jsonLdTypes(node: JsonLdNode): string[] {
  const types = node['@type'];
  return (Array.isArray(types) ? types : [types])
    .filter((type): type is string => typeof type === 'string')
    .map((type) => type.replace(SCHEMA_PREFIX, ''));
}

/** JSON, or JSON with raw control characters (which sites leave inside strings) read as spaces. */
function parseJson(text: string): unknown {
  for (const form of [text, text.replace(/[\u0000-\u001f]+/gu, ' ')]) {
    try {
      return JSON.parse(form) as unknown;
    } catch {
      // Try the next form.
    }
  }
  return undefined;
}

function collectNodes(value: unknown, into: JsonLdNode[], depth: number): void {
  if (depth > 8 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectNodes(item, into, depth + 1);
    return;
  }
  const node = value as JsonLdNode;
  if ('@type' in node) into.push(node);
  collectNodes(node['@graph'], into, depth + 1);
  collectNodes(node.mainEntity, into, depth + 1);
}

function canonical(links: Element[], url: string): string {
  const page = new URL(url);
  page.hash = '';
  const link = links.find((element) =>
    (element.attribs.rel ?? '').toLowerCase().split(/\s+/u).includes('canonical'),
  );
  const href = link?.attribs.href?.trim();
  if (href !== undefined && URL.canParse(href, page.href)) {
    const target = new URL(href, page.href);
    target.hash = '';
    // A username or password would be published with the address, so such an address is refused.
    const hasCredentials = target.username !== '' || target.password !== '';
    if (target.protocol === 'https:' && target.host === page.host && !hasCredentials) {
      return target.href;
    }
  }
  // The page's own address, without credentials either.
  page.username = '';
  page.password = '';
  return page.href;
}

/**
 * An attribute's value, found by its name in any case. Only the element's own attributes count,
 * so a name such as `constructor` finds nothing.
 */
function attributeOf(element: Element, attribute: string): string | undefined {
  const name = attribute.toLowerCase();
  return Object.hasOwn(element.attribs, name) ? element.attribs[name] : undefined;
}

/**
 * The text under `root` (the page's <main>, or else its <body>), on one line. Outside <main>,
 * navigation, headers, and footers are site chrome, not the product, so they're left out.
 */
function mainText(root: Element | null, fallback: AnyNode[]): string {
  const skipped = root?.name === 'main' ? NEVER_TEXT : new Set([...NEVER_TEXT, ...CHROME]);
  const parts: string[] = [];
  // An explicit stack, not recursion, because a page can nest deeper than the call stack allows.
  // Children go on in reverse, so they come off in document order.
  const stack: AnyNode[] = [...(root?.children ?? fallback)].reverse();
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (isText(node)) parts.push(node.data);
    else if (isTag(node) && !skipped.has(node.name)) {
      for (const child of node.children.toReversed()) stack.push(child);
    }
  }
  // A cut through a surrogate pair leaves a lone high surrogate at the end. That isn't well formed
  // text, and the text goes to the LLM as JSON, so it's dropped.
  return parts
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, PAGE_TEXT_MAX)
    .replace(/[\uD800-\uDBFF]$/u, '');
}
