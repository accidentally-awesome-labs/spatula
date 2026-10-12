import { selectOne } from 'css-select';
import { DomHandler, isTag, isText, type AnyNode, type Element } from 'domhandler';
import { DomUtils, Parser } from 'htmlparser2';

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
 * The deepest a page may nest its elements. Real product pages nest a few dozen deep. Reading a
 * page, the parse and every walk over its tree alike, takes time that grows with its depth, and a
 * Worker can't catch running out of CPU, so a page past this is refused before it's read.
 */
export const MAX_NESTING = 1_000;

const NEVER_TEXT = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'head']);
const CHROME = new Set(['nav', 'header', 'footer']);
const SCHEMA_PREFIX = /^(?:https?:\/\/schema\.org\/|schema:)/u;

/**
 * Builds the tree, and stops the moment htmlparser2's own stack of open elements passes
 * MAX_NESTING. The depth has to come from the parser: what an unclosed tag, a stray end tag, or
 * `<div/>` means is its decision, and a guess made from the text disagreed with it.
 */
class DepthLimitedHandler extends DomHandler {
  override onopentag(name: string, attribs: Record<string, string>): void {
    super.onopentag(name, attribs);
    // The stack holds the document, then every open element down to the one just opened.
    if (this.tagStack.length - 1 > MAX_NESTING) {
      throw new Error(
        `the page nests elements more than ${MAX_NESTING.toLocaleString('en-US')} deep`,
      );
    }
  }
}

/** Reads a page. It throws for one that nests elements more than MAX_NESTING deep. */
export function parsePage(html: string, url: string): Page {
  const handler = new DepthLimitedHandler();
  new Parser(handler).end(html);
  const document = handler.root;
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
