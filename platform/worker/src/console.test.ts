import { MATCH_RELATIONSHIPS } from '@spatula/core';
import { testTaxonomy } from '@spatula/store/fixtures';
import { createContext, runInContext, Script } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { CONSOLE_CSS, CONSOLE_HTML, CONSOLE_SCRIPT } from './console/page';

/*
 * The console's page as a browser runs it (ADR 0009, Review Focus 4). Its script runs in a context
 * of its own, over a small DOM that can't parse markup: innerHTML and its kin throw. The API's
 * answers below carry markup and javascript: addresses wherever a page's or a person's text goes,
 * and they must come out as text, with links only to https: pages and to the console's own views.
 */

type Listener = (event: { type: string; target: FakeNode; preventDefault(): void }) => unknown;

/** An element or a text node, as far as the console uses them. */
class FakeNode {
  readonly tagName: string;
  readonly document: FakeDocument;
  children: FakeNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();
  parent: FakeNode | null = null;
  value = '';
  checked = false;
  disabled = false;
  hidden = false;
  private ownText = '';

  constructor(tagName: string, document: FakeDocument) {
    this.tagName = tagName;
    this.document = document;
  }

  get textContent(): string {
    if (this.tagName === '#text') return this.ownText;
    return this.children.map((child) => child.textContent).join('');
  }

  set textContent(text: string) {
    if (this.tagName === '#text') this.ownText = String(text);
    else this.replaceChildren(String(text));
  }

  // What parses markup isn't here to call: a script that tried would throw.
  set innerHTML(_: string) {
    throw new Error('The console set innerHTML.');
  }

  set outerHTML(_: string) {
    throw new Error('The console set outerHTML.');
  }

  insertAdjacentHTML(): never {
    throw new Error('The console called insertAdjacentHTML.');
  }

  setAttribute(name: string, value: unknown): void {
    this.attributes.set(name.toLowerCase(), String(value));
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name.toLowerCase());
  }

  append(...nodes: (FakeNode | string)[]): void {
    for (const node of nodes) {
      if (typeof node !== 'string' && !(node instanceof FakeNode)) {
        throw new TypeError(`append takes nodes and text, not ${typeof node}.`);
      }
      const child = typeof node === 'string' ? this.document.createTextNode(node) : node;
      const from = child.parent;
      if (from !== null) from.children.splice(from.children.indexOf(child), 1);
      child.parent = this;
      this.children.push(child);
    }
  }

  replaceChildren(...nodes: (FakeNode | string)[]): void {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...nodes);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  focus(): void {
    this.document.activeElement = this;
  }

  async fire(type: string): Promise<void> {
    for (const listener of this.listeners.get(type) ?? []) {
      await listener({ type, target: this, preventDefault() {} });
    }
  }

  /** This node and every node under it, in document order. */
  *all(): Generator<FakeNode> {
    yield this;
    for (const child of this.children) yield* child.all();
  }
}

class FakeDocument {
  activeElement: FakeNode | null = null;
  readonly byId = new Map<string, FakeNode>();

  createElement(tag: string): FakeNode {
    return new FakeNode(String(tag).toLowerCase(), this);
  }

  createTextNode(text: string): FakeNode {
    const node = new FakeNode('#text', this);
    node.textContent = text;
    return node;
  }

  getElementById(id: string): FakeNode | null {
    return this.byId.get(id) ?? null;
  }
}

const tx = (n: number) => `tx_${String(n).padStart(20, '0')}`;

// Text from pages, from a decider, and from people, each trying to become markup or a link.
const HOSTILE_URL = 'javascript:alert(1)//https://maker-a.example/a1';
const HOSTILE_REASON = '<img src=x onerror="alert(1)"> sits <b>over</b> the ears';
const HOSTILE_CAPTURE = 'cp_"><img src=x>';
const HOSTILE_PAGE = 'https://maker-a.example/a3"><script>alert(1)</script>';
const CAPTURE_VIEW = `#capture/hostile/${encodeURIComponent(HOSTILE_CAPTURE)}`;

const PLACE = {
  id: 'rv_place',
  kind: 'classify',
  subject: 'it_a1',
  question: {
    type: 'taxonomy',
    prompt: 'Where does the one product this page is about sit in the taxonomy?',
    parts: {
      shelves: [tx(5), tx(6), tx(7), 'none'],
      functions: [],
      features: { [tx(13)]: [tx(14), tx(15)] },
    },
  },
  context: {
    url: HOSTILE_URL,
    field: 'taxonomy',
    version: 1,
    proposed: { shelf: tx(6), functions: [], values: [tx(14)] },
    settled: { shelf: null, functions: [], values: [] },
    probabilities: { [`shelf:${tx(6)}`]: 0.6, [`value:${tx(14)}`]: 0.7 },
    reason: HOSTILE_REASON,
    captureId: HOSTILE_CAPTURE,
  },
  createdAt: '2026-10-20T08:00:00.000Z',
  suggestion: { shelf: 'on-ear', features: { back: ['closed'] } },
};

const MATCH = {
  id: 'rv_match',
  kind: 'match',
  subject: 'it_a3|sp_one',
  question: {
    type: 'choice',
    prompt: 'Is this page the same product as the record?',
    options: ['same', 'variant', 'different'],
  },
  context: {
    page: HOSTILE_PAGE,
    entity: 'http://maker-a.example/a1',
    record: 'sp_one',
    proposed: 'same',
    probabilities: { same: 0.5, '<b>variant</b>': 0.45 },
    reason: 'The names agree.',
  },
  createdAt: '2026-10-20T08:00:00.000Z',
  flagged: true,
};

const PROPOSAL = {
  id: 'tp_one',
  kind: 'add-subcategory',
  change: {
    kind: 'add-subcategory',
    parent: 'amplifiers',
    slug: 'phono-stages',
    name: 'Phono <i>stages</i>',
    description: 'Raise a cartridge’s signal',
    implies: ['pre-amp'],
    scopeClause: 'amplifiers',
  },
  why: '<script>alert(2)</script> pages answered none look alike',
  // As Task 14's ProposalEvidence and ProposalImpact have them: pages are objects, the shelf is a
  // slug, and a split's migration lists the shelves it would create by slug.
  evidence: {
    pages: [
      { address: 'https://maker-a.example/p1', title: 'Phono <b>stage</b> P1', shelf: 'dacs' },
      { address: 'javascript:alert(2)', title: null, shelf: null },
      { address: 'https://maker-a.example/p3', title: 'P3', shelf: 'none' },
    ],
  },
  impact: {
    pagesToRedecide: 3,
    moves: [
      { from: 'amplifiers', to: null, pages: 2 },
      { from: 'dacs', to: 'preamps', pages: 3 },
    ],
    questions: 3,
    leaving: 1,
    tokens: 1800,
    migration: [
      {
        version: 3,
        kind: 'split',
        subject: 'shelf',
        from: tx(9),
        to: ['phono-<i>a</i>', 'phono-b'],
      },
    ],
  },
  status: 'open',
  createdAt: '2026-10-20T08:00:00.000Z',
};

const VERSIONS = [
  {
    datasetId: 'hostile',
    version: 2,
    changes: [{ summary: 'Add <b>Phono</b> under Amplifiers' }],
    actor: { role: 'decider', client: 'run' },
    autonomous: true,
    proposalId: 'tp_zero',
    undoes: null,
    createdAt: '2026-10-20T09:00:00.000Z',
  },
  {
    datasetId: 'hostile',
    version: 1,
    changes: [],
    actor: { role: 'owner', client: 'cli' },
    autonomous: false,
    proposalId: null,
    undoes: null,
    createdAt: '2026-10-19T09:00:00.000Z',
  },
];

const LOGGED = {
  id: 'ra_1',
  action: 'answer',
  subject: 'rv_place',
  actor: { role: 'reviewer', client: 'consumer', consumer: 'crowdio', reviewer: '<b>r-17</b>' },
  detail: { parts: { shelf: 'on-ear' }, note: '<img src=x>' },
  at: '2026-10-20T10:00:00.000Z',
};

const CAPTURED = {
  capture: {
    id: HOSTILE_CAPTURE,
    url: 'https://maker-a.example/a1',
    finalUrl: 'https://maker-a.example/a1',
    httpStatus: 200,
    fetchedAt: '2026-10-20T07:00:00.000Z',
    contentHash: 'abc',
    bytes: 4096,
    storedBytes: 900,
    etag: null,
    lastModified: null,
    signals: { 'ai-input': 'yes' },
  },
  read: {
    reader: 1,
    url: 'https://maker-a.example/a1',
    canonicalUrl: 'javascript:alert(3)',
    title: '<script>alert(4)</script>',
    breadcrumbs: ['Home', '<b>Amps</b>'],
    jsonLd: [{ '@type': 'Product', name: '</pre><script>alert(5)</script>' }],
    jsonLdErrors: 0,
    meta: { description: ['<i>x</i>'] },
    text: 'Impedance: 300 Ω <script>alert(6)</script>',
  },
};

/** The console API's answers, by method and address. */
const ROUTES: Record<string, unknown> = {
  'GET /console/api/datasets': { datasets: [{ id: 'hostile', revision: 1, headGeneration: 0 }] },
  'GET /console/api/datasets/hostile/taxonomy': {
    version: 2,
    taxonomy: { ...testTaxonomy(), version: 2 },
  },
  'GET /console/api/datasets/hostile/review': { reviews: [PLACE, MATCH] },
  'POST /console/api/datasets/hostile/review/rv_place': {
    answered: 'rv_place',
    effect: 'The page sits on Headphones › On-ear.',
  },
  'POST /console/api/datasets/hostile/review/bulk': {
    // Task 12's answer: a status for each, and `answered`, `flagged`, or `error` beside it.
    results: [
      {
        reviewId: 'rv_place',
        status: 200,
        answered: 'rv_place',
        effect: 'The page sits on Headphones.',
      },
    ],
  },
  'GET /console/api/datasets/hostile/proposals?status=open': { proposals: [PROPOSAL] },
  'POST /console/api/datasets/hostile/proposals/tp_one': { version: 3 },
  // Task 16's answer: the run that earns autonomy, and every earnable kind with its run.
  'GET /console/api/datasets/hostile/autonomy': {
    after: 10,
    kinds: [
      { kind: 'add-subcategory', streak: 4, earned: false, updatedAt: '2026-10-19T09:00:00.000Z' },
      { kind: 'add-feature', streak: 0, earned: false, updatedAt: null },
      { kind: 'add-value', streak: 11, earned: true, updatedAt: '2026-10-20T09:00:00.000Z' },
    ],
  },
  'POST /console/api/datasets/hostile/autonomy/add-value/revoke': {
    kind: 'add-value',
    streak: 0,
    was: 11,
  },
  'GET /console/api/datasets/hostile/taxonomy/versions': { versions: VERSIONS },
  'POST /console/api/datasets/hostile/taxonomy/versions/2/undo': { version: 3 },
  'GET /console/api/datasets/hostile/review/log': { actions: [LOGGED] },
  [`GET /console/api/datasets/hostile/captures/${encodeURIComponent(HOSTILE_CAPTURE)}`]: CAPTURED,
};

interface SentRequest {
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

/** Lets the script's requests and drawing finish. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** The console's page, opened at this hash over the answers above, and what it sent. */
async function opened(hash = '#questions', overrides: Record<string, unknown> = {}) {
  const routes = { ...ROUTES, ...overrides };
  const sent: SentRequest[] = [];
  const document = new FakeDocument();
  for (const [id, tag] of [
    ['main', 'main'],
    ['dataset', 'select'],
    ['status', 'p'],
    ['screen-questions', 'a'],
    ['screen-proposals', 'a'],
    ['screen-history', 'a'],
  ] as const) {
    document.byId.set(id, document.createElement(tag));
  }
  const window = document.createElement('#window');
  const location = { hash };
  const context = createContext({ document, window, location, URL, URLSearchParams });
  // A browser's fetch gives the page JSON of the page's own realm.
  const parse = runInContext('JSON.parse', context) as (text: string) => unknown;
  context.fetch = async (
    url: string,
    init: { method?: string; body?: string; headers?: Record<string, string> } = {},
  ) => {
    const method = init.method ?? 'GET';
    sent.push({
      method,
      url,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
      headers: { ...init.headers },
    });
    const key = `${method} ${url}`;
    const found = Object.hasOwn(routes, key);
    return {
      ok: found,
      status: found ? 200 : 404,
      type: 'basic',
      json: async () => parse(JSON.stringify(found ? routes[key] : { error: 'Not found.' })),
    };
  };
  runInContext(CONSOLE_SCRIPT, context);
  await settle();
  const show = async (next: string) => {
    location.hash = next;
    await window.fire('hashchange');
    await settle();
  };
  return { document, main: document.getElementById('main')!, sent, show };
}

/** Elements that load or run something: nothing the console shows may become one. */
const ACTIVE = ['script', 'style', 'iframe', 'object', 'embed', 'img', 'base', 'link', 'meta'];

/**
 * The nodes under `main`, once checked: no element that loads or runs anything, no handler
 * attribute, and no link but to an https: page or to one of the console's own views.
 */
function checked(main: FakeNode): FakeNode[] {
  const nodes = [...main.all()];
  for (const node of nodes) {
    const href = node.attributes.get('href');
    if (href !== undefined) expect(href).toMatch(/^(?:https:\/\/|#)/u);
    for (const name of node.attributes.keys()) expect(name).not.toMatch(/^on/u);
    expect(ACTIVE).not.toContain(node.tagName);
  }
  return nodes;
}

const hrefs = (nodes: FakeNode[]) => nodes.flatMap((node) => node.attributes.get('href') ?? []);

/** What an answered question's card says of the parts it doesn't ask. */
const STANDS = 'Parts this question doesn’t ask stay as the page has them now.';

describe('the console', () => {
  it('never puts data into markup', () => {
    // Nothing in the script parses markup, runs text as code, or writes the document.
    for (const banned of [
      /\.innerHTML\b/u,
      /\.outerHTML\b/u,
      /insertAdjacentHTML/u,
      /document\.write/u,
      /\beval\s*\(/u,
      /\bnew\s+Function\b/u,
      /javascript:/iu,
      /\.srcdoc\b/u,
      /DOMParser/u,
      /createContextualFragment/u,
      /\.style\b/u,
    ]) {
      expect(CONSOLE_SCRIPT).not.toMatch(banned);
    }
    // It's whole, plain script.
    expect(() => new Script(CONSOLE_SCRIPT)).not.toThrow();
    // The page loads its own script and style, and has nothing inline.
    expect(CONSOLE_HTML.match(/<script\b[^>]*>/gu)).toEqual([
      '<script src="/console/app.js" defer>',
    ]);
    expect(CONSOLE_HTML).not.toMatch(/\son[a-z]+=|\sstyle=|<style/iu);
    expect(CONSOLE_CSS).not.toMatch(/url\(|@import|expression\(/iu);
  });

  it('shows page and people’s text as text, and links only to https: pages and its own views', async () => {
    const { main } = await opened();
    const nodes = checked(main);
    expect(main.children[0]!.textContent).toBe('Questions');
    for (const text of [HOSTILE_URL, HOSTILE_REASON, HOSTILE_PAGE, '<b>variant</b>']) {
      expect(main.textContent).toContain(text);
    }
    expect(main.textContent).toContain('Proposed: Headphones › Over-ear (0.60); Back: Open');
    expect(main.textContent).toContain('Suggested: Headphones › On-ear; Back: Closed');
    expect(main.textContent).toContain('Flagged: a reviewer’s answer differs');
    // An open question says nothing of the page as it stands: what it settled is current.
    expect(main.textContent).not.toContain(STANDS);
    expect(hrefs(nodes)).toEqual([CAPTURE_VIEW, new URL(HOSTILE_PAGE).href]);
  });

  it('answers a question in parts, with a note, and moves focus to what it did', async () => {
    const { document, main, sent } = await opened();
    const card = [...main.all()].find(
      (node) => node.tagName === 'article' && node.textContent.includes(HOSTILE_URL),
    )!;
    const inCard = [...card.all()];
    const shelf = inCard.find((node) => node.tagName === 'select')!;
    // The decider's proposal is chosen to begin with.
    expect(shelf.value).toBe(tx(6));
    shelf.value = tx(7);
    const choice = (label: string) =>
      inCard
        .find((node) => node.tagName === 'label' && node.textContent === label)!
        .children.find((child) => child.tagName === 'input')!;
    expect(choice('Open').checked).toBe(true);
    choice('Open').checked = false;
    choice('Closed').checked = true;
    inCard.find((node) => node.tagName === 'textarea')!.value = ' Pads, not cups. ';
    await inCard.find((node) => node.tagName === 'form')!.fire('submit');
    await settle();
    expect(sent.at(-1)).toEqual({
      method: 'POST',
      url: '/console/api/datasets/hostile/review/rv_place',
      body: { parts: { shelf: tx(7), features: { [tx(13)]: [tx(15)] } }, note: 'Pads, not cups.' },
      headers: { 'content-type': 'application/json' },
    });
    expect(card.textContent).toBe('Answered rv_place. The page sits on Headphones › On-ear.');
    expect(document.activeElement).toBe(card.children[0]);
  });

  it('accepts the suggestions chosen, in one request', async () => {
    const { document, main, sent } = await opened();
    const button = (label: string) =>
      [...main.all()].find((node) => node.tagName === 'button' && node.textContent === label)!;
    await button('Choose every suggestion').fire('click');
    await button('Accept 1 suggestion').fire('click');
    await settle();
    expect(sent.find((one) => one.method === 'POST')).toMatchObject({
      url: '/console/api/datasets/hostile/review/bulk',
      body: { answers: [{ reviewId: 'rv_place', suggestion: true }] },
    });
    expect(document.getElementById('status')!.textContent).toBe('Accepted 1 of 1 suggestions.');
  });

  it('shows proposals, history, and a capture as text too, and decides and undoes', async () => {
    const { main, sent, show } = await opened();
    const screens: [string, string, string[]][] = [
      [
        '#proposals',
        'Proposals',
        [
          'Add Phono <i>stages</i> under Amplifiers',
          '<script>alert(2)</script> pages answered none look alike',
          'javascript:alert(2)',
          'Phono <b>stage</b> P1',
          'Applies on its own',
          // The moves' pages add up: 2 and 3, not the two moves.
          'Pages that move: 5',
          'Records that leave the snapshot: 1',
          // A split's new shelves come as the slugs the preview made, shown as they are.
          'Split Amplifiers into phono-<i>a</i>, phono-b: its pages stay',
        ],
      ],
      [
        '#history',
        'History',
        [
          'Add <b>Phono</b> under Amplifiers',
          'Reviewer <b>r-17</b> for crowdio',
          'Note: <img src=x>',
        ],
      ],
      [
        CAPTURE_VIEW,
        'The page as Spatula saw it',
        [
          '<script>alert(4)</script>',
          'javascript:alert(3)',
          '</pre><script>alert(5)</script>',
          'Impedance: 300 Ω <script>alert(6)</script>',
        ],
      ],
    ];
    for (const [hash, heading, texts] of screens) {
      await show(hash);
      const nodes = checked(main);
      expect(main.children[0]!.textContent).toBe(heading);
      for (const text of texts) expect(main.textContent).toContain(text);
      if (hash === '#proposals') {
        expect(hrefs(nodes)).toEqual(['https://maker-a.example/p1', 'https://maker-a.example/p3']);
      }
      if (hash === CAPTURE_VIEW) {
        expect(hrefs(nodes)).toEqual([
          '#questions',
          'https://maker-a.example/a1',
          'https://maker-a.example/a1',
        ]);
      }
    }

    await show('#proposals');
    const accept = [...main.all()].find(
      (node) => node.tagName === 'button' && node.textContent === 'Accept',
    )!;
    await accept.fire('click');
    await settle();
    expect(sent.at(-1)).toMatchObject({
      method: 'POST',
      url: '/console/api/datasets/hostile/proposals/tp_one',
      body: { decision: 'accept' },
    });
    expect(main.textContent).toContain('Applied: the taxonomy is at version 3 now.');

    await show('#history');
    const undo = [...main.all()].find(
      (node) => node.tagName === 'button' && node.textContent === 'Undo version 2',
    )!;
    await undo.fire('click');
    await settle();
    expect(sent.some((one) => one.url.endsWith('/taxonomy/versions/2/undo'))).toBe(true);
  });

  it('offers the owner each reviewer’s answer in the history, to replace with their own', async () => {
    const answered = {
      ...PLACE,
      status: 'decided',
      answer: JSON.stringify({ shelf: tx(6), functions: [], values: [tx(14)] }),
      answeredBy: LOGGED.actor,
      note: '<img src=x>',
      closedAt: '2026-10-20T10:00:00.000Z',
    };
    const { document, main, sent } = await opened('#history', {
      'GET /console/api/datasets/hostile/review/rv_place': { review: answered },
      'POST /console/api/datasets/hostile/review/rv_place': {
        answered: 'rv_place',
        effect: 'It replaces a reviewer’s answer. The page sits on Headphones › On-ear.',
      },
    });
    const offered = [...main.all()].filter(
      (node) => node.tagName === 'button' && node.textContent === 'Answer it yourself',
    );
    // One answer is logged, a reviewer's.
    expect(offered).toHaveLength(1);
    await offered[0]!.fire('click');
    await settle();
    expect(sent.at(-1)).toMatchObject({
      method: 'GET',
      url: '/console/api/datasets/hostile/review/rv_place',
    });
    checked(main);
    const said = 'A reviewer answered rv_place: Headphones › Over-ear; Back: Open.';
    expect(document.activeElement!.textContent).toBe(
      `${said} Your different answer replaces theirs.`,
    );
    const card = [...main.all()].find((node) => node.tagName === 'article')!;
    expect(card.textContent).toContain(HOSTILE_REASON);
    // What it settled then isn't what the answer keeps: the page as it stands is.
    expect(card.textContent).toContain(STANDS);
    const inCard = [...card.all()];
    inCard.find((node) => node.tagName === 'select')!.value = tx(7);
    await inCard.find((node) => node.tagName === 'form')!.fire('submit');
    await settle();
    expect(sent.at(-1)).toMatchObject({
      method: 'POST',
      url: '/console/api/datasets/hostile/review/rv_place',
      body: { parts: { shelf: tx(7), features: { [tx(13)]: [tx(14)] } } },
    });
    expect(card.textContent).toBe(
      'Answered rv_place. It replaces a reviewer’s answer. The page sits on Headphones › On-ear.',
    );
  });

  it('warns that undoing the undo of a merge retires the item rather than merging it again', async () => {
    const restored = {
      ...VERSIONS[0],
      version: 3,
      changes: [
        {
          change: { kind: 'restore', subject: 'shelf', item: tx(9) },
          summary: 'Restore Preamps',
        },
      ],
      actor: { role: 'owner', client: 'console' },
      autonomous: false,
      undoes: 2,
    };
    const { main } = await opened('#history', {
      'GET /console/api/datasets/hostile/taxonomy/versions': {
        versions: [restored, ...VERSIONS],
      },
    });
    const warnings = [...main.all()]
      .filter((node) => node.tagName === 'details')
      .map((node) => node.textContent);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(
      'Undoing a restore retires the item again: an undone merge isn’t merged again, so answers' +
        ' about the item reopen.',
    );
  });

  it('reads Task 12’s bulk answer: a status for each, and the reason for the ones not taken', async () => {
    const second = { ...PLACE, id: 'rv_second', suggestion: { shelf: 'dacs' } };
    const third = { ...PLACE, id: 'rv_third', suggestion: { shelf: 'on-ear' } };
    const { document, main, sent } = await opened('#questions', {
      'GET /console/api/datasets/hostile/review': { reviews: [PLACE, second, third] },
      'POST /console/api/datasets/hostile/review/bulk': {
        results: [
          { reviewId: 'rv_place', status: 200, answered: 'rv_place', effect: 'Done.' },
          { reviewId: 'rv_second', status: 409, error: 'That question has been answered already.' },
          { reviewId: 'rv_third', status: 202, flagged: 'rv_third', effect: 'It waits.' },
        ],
      },
    });
    const button = (label: string) =>
      [...main.all()].find((node) => node.tagName === 'button' && node.textContent === label)!;
    await button('Choose every suggestion').fire('click');
    await button('Accept 3 suggestions').fire('click');
    await settle();
    expect(sent.find((one) => one.method === 'POST')).toMatchObject({
      body: {
        answers: [
          { reviewId: 'rv_place', suggestion: true },
          { reviewId: 'rv_second', suggestion: true },
          { reviewId: 'rv_third', suggestion: true },
        ],
      },
    });
    // A 200 and a 202 (flagged for the owner) are taken; the 409's reason is the API's error.
    expect(document.getElementById('status')!.textContent).toBe(
      'Accepted 2 of 3 suggestions. Not taken: rv_second: That question has been answered already.',
    );
  });

  it('says a flagged answer was flagged, as the review API’s 202 reply does', async () => {
    const said = 'It differs from a person’s answer, so it waits for the owner.';
    const { main } = await opened('#questions', {
      'POST /console/api/datasets/hostile/review/rv_place': { flagged: 'rv_place', effect: said },
    });
    const card = [...main.all()].find(
      (node) => node.tagName === 'article' && node.textContent.includes(HOSTILE_URL),
    )!;
    await [...card.all()].find((node) => node.tagName === 'form')!.fire('submit');
    await settle();
    expect(card.textContent).toBe(`Flagged rv_place. ${said}`);
  });

  it('answers a page that is none of these without values, and hides what it would take', async () => {
    const { main, sent } = await opened();
    const card = [...main.all()].find(
      (node) => node.tagName === 'article' && node.textContent.includes(HOSTILE_URL),
    )!;
    const inCard = [...card.all()];
    const shelf = inCard.find((node) => node.tagName === 'select')!;
    // The decider proposed an Open back, which is ticked: choosing none must not send it.
    const open = inCard
      .find((node) => node.tagName === 'label' && node.textContent === 'Open')!
      .children.find((child) => child.tagName === 'input')!;
    expect(open.checked).toBe(true);
    const groups = inCard.filter((node) => node.tagName === 'fieldset');
    expect(groups.length).toBeGreaterThan(0);
    shelf.value = 'none';
    await shelf.fire('change');
    for (const group of groups) expect(group.hidden).toBe(true);
    await inCard.find((node) => node.tagName === 'form')!.fire('submit');
    await settle();
    expect(sent.at(-1)).toMatchObject({
      url: '/console/api/datasets/hostile/review/rv_place',
      body: { parts: { shelf: 'none' } },
    });
    expect(JSON.stringify(sent.at(-1)!.body)).not.toMatch(/features|values/u);
    // Another shelf shows them again, with the boxes as they were.
    shelf.value = tx(7);
    await shelf.fire('change');
    for (const group of groups) expect(group.hidden).toBe(false);
  });

  it('offers a match question’s own answers, then the five relationships', async () => {
    const { main } = await opened();
    const card = [...main.all()].find(
      (node) => node.tagName === 'article' && node.textContent.includes(HOSTILE_PAGE),
    )!;
    const answers = [...card.all()]
      .filter((node) => node.tagName === 'button')
      .map((node) => node.textContent)
      .filter((label) => !label.startsWith('Accept'));
    // The old question's three, with same only once, then the rest of the relationships.
    expect(answers).toEqual([
      'same',
      'variant',
      'different',
      'edition',
      'spec-version',
      'other-model',
      'unrelated',
    ]);
  });

  it('names each of core’s match relationships, so its copy can’t drift', () => {
    for (const relationship of MATCH_RELATIONSHIPS) {
      expect(CONSOLE_SCRIPT, relationship).toContain(`'${relationship}'`);
    }
    // And in core's order, as one list.
    expect(CONSOLE_SCRIPT).toContain(MATCH_RELATIONSHIPS.map((one) => `'${one}'`).join(', '));
  });

  it('reads the autonomy run and the kinds from the API, not from the page', async () => {
    const { main, sent } = await opened('#proposals', {
      'GET /console/api/datasets/hostile/autonomy': {
        after: 7,
        kinds: [
          { kind: 'add-value', streak: 7, earned: true, updatedAt: '2026-10-20T09:00:00.000Z' },
          {
            kind: 'add-subcategory',
            streak: 2,
            earned: false,
            updatedAt: '2026-10-20T09:00:00.000Z',
          },
        ],
      },
      'POST /console/api/datasets/hostile/autonomy/add-value/revoke': {
        kind: 'add-value',
        streak: 0,
        was: 7,
      },
    });
    // The autonomy section alone: a proposal's card on the same screen names its kind too.
    const section = [...main.all()].find((node) => node.tagName === 'section')!;
    const text = section.textContent;
    expect(text).toContain('once you’ve accepted 7 of its proposals in a row');
    expect(text).toContain('Applies on its own');
    expect(text).toContain('Waits for you');
    // Only the kinds the API listed have a row: a header, and two kinds, in the API's order.
    expect([...section.all()].filter((node) => node.tagName === 'tr')).toHaveLength(3);
    expect(
      [...section.all()]
        .filter((node) => node.tagName === 'th' && node.attributes.get('scope') === 'row')
        .map((node) => node.textContent),
    ).toEqual(['A new feature value', 'A new subcategory']);
    const revoke = [...main.all()].find(
      (node) => node.tagName === 'button' && node.textContent === 'Revoke it',
    )!;
    await revoke.fire('click');
    await settle();
    expect(sent.find((one) => one.url.endsWith('/autonomy/add-value/revoke'))).toMatchObject({
      method: 'POST',
      body: {},
    });
  });
});
