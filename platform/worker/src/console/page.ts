/*
 * The console's page, style, and script (ADR 0009), which ./routes.ts serves. They're strings
 * because a Worker has no files of its own to serve. The script builds every node itself, with
 * createElement, textContent, and setAttribute, so nothing it shows is read as markup (Review
 * Focus 4).
 */

export const CONSOLE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>Spatula console</title>
    <link rel="stylesheet" href="/console/app.css" />
    <script src="/console/app.js" defer></script>
  </head>
  <body>
    <header class="top">
      <p class="brand">Spatula console</p>
      <nav aria-label="Screens">
        <a id="screen-questions" href="#questions">Questions</a>
        <a id="screen-proposals" href="#proposals">Proposals</a>
        <a id="screen-history" href="#history">History</a>
      </nav>
      <label class="dataset"><span>Dataset</span> <select id="dataset"></select></label>
    </header>
    <main id="main"><p class="muted">Loading…</p></main>
    <p id="status" class="status" role="status" aria-live="polite"></p>
    <noscript><p class="status">The console needs JavaScript.</p></noscript>
  </body>
</html>
`;

/** System fonts only, so the page loads nothing but this file and the script. */
export const CONSOLE_CSS = `:root {
  color-scheme: light dark;
  --bg: #f4f5f2;
  --surface: #ffffff;
  --surface-2: #eceee9;
  --ink: #171b19;
  --ink-soft: #3a4340;
  --muted: #5b6661;
  --line: #d2d8d3;
  --accent: #2a4f8c;
  --on-accent: #ffffff;
  --ok: #276f45;
  --warn: #a24f0a;
  --danger: #a3271f;
  --font: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111513;
    --surface: #181d1b;
    --surface-2: #212724;
    --ink: #e6ebe8;
    --ink-soft: #c2cbc6;
    --muted: #94a19a;
    --line: #2f3633;
    --accent: #93b2ee;
    --on-accent: #0d1420;
    --ok: #74c995;
    --warn: #f1a660;
    --danger: #f08c84;
  }
}

/* The page. */
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html { background: var(--bg); color: var(--ink); font: 15px/1.5 var(--font); }
body { margin: 0; }
a { color: var(--accent); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.top {
  position: sticky; top: 0; z-index: 1; display: flex; flex-wrap: wrap; align-items: center;
  gap: 8px 24px; padding: 10px 16px; background: var(--surface);
  border-bottom: 1px solid var(--line);
}
.brand { margin: 0; font-weight: 700; }
.top nav { display: flex; gap: 16px; }
.top nav a {
  padding: 4px 0; color: var(--ink-soft); text-decoration: none;
  border-bottom: 2px solid transparent;
}
.top nav a[aria-current='page'] { color: var(--ink); border-bottom-color: var(--accent); }
.dataset { display: flex; align-items: center; gap: 8px; margin-left: auto; }
main { max-width: 1120px; margin: 0 auto; padding: 20px 16px 80px; }
main[aria-busy='true'] { opacity: 0.6; }
h1 { margin: 0 0 12px; font-size: 1.6rem; }
h2 { margin: 0 0 6px; font-size: 1.15rem; overflow-wrap: anywhere; }
h3 { margin: 16px 0 6px; font-size: 1rem; }
h4 {
  margin: 12px 0 4px; color: var(--muted); font-size: 0.8rem; letter-spacing: 0.04em;
  text-transform: uppercase;
}
.lede, .muted, .meta { color: var(--muted); }
.meta { margin: 0 0 8px; font-size: 0.85rem; }
.mono, pre, textarea.mono { font-family: var(--mono); font-size: 0.85rem; }
.address { overflow-wrap: anywhere; }

/* Cards: what a question or a proposal rests on, beside what to do about it. */
.cards { display: grid; gap: 16px; }
.card {
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 340px); gap: 4px 24px;
  padding: 16px; background: var(--surface); border: 1px solid var(--line); border-radius: 8px;
}
.card > h2, .card > .meta, .card > .done { grid-column: 1 / -1; }
.card.flagged { border-left: 4px solid var(--warn); }
.evidence, .answer, .decide { display: grid; align-content: start; gap: 6px; min-width: 0; }
.evidence p, .answer p, .decide p { margin: 0; }
.flag { color: var(--warn); font-weight: 600; }
.chances { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.chances li {
  display: grid; grid-template-columns: minmax(0, 1fr) 90px 44px; align-items: center; gap: 8px;
}
meter { width: 100%; }
.suggestion {
  display: grid; gap: 6px; margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--line);
}

/* Forms. */
fieldset {
  display: grid; gap: 4px; margin: 0; padding: 8px 10px; border: 1px solid var(--line);
  border-radius: 6px;
}
legend { padding: 0 4px; font-weight: 600; }
.parts, .edit { display: grid; gap: 10px; }
.part, .filters label { display: grid; gap: 4px; }
.tick { display: flex; align-items: center; gap: 8px; }
input[type='text'], input[type='number'], select, textarea {
  width: 100%; padding: 6px 8px; color: var(--ink); font: inherit; background: var(--bg);
  border: 1px solid var(--line); border-radius: 6px;
}
.dataset select { width: auto; }
button {
  padding: 6px 14px; color: var(--on-accent); font: inherit; background: var(--accent);
  border: 1px solid var(--accent); border-radius: 6px; cursor: pointer;
}
button.quiet { color: var(--accent); background: transparent; }
button:disabled { cursor: default; opacity: 0.5; }
.row, .options, .bulk { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.bulk { margin: 0 0 16px; }
.filters {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); align-items: end;
  gap: 10px; margin: 0 0 16px; padding: 12px; background: var(--surface);
  border: 1px solid var(--line); border-radius: 8px;
}
.error { margin: 0; color: var(--danger); }
.error:empty { display: none; }
.done { margin: 0; color: var(--ok); font-weight: 600; }
/* Empty, it takes no room, and stays a live region that reads out what comes next. */
.status {
  position: fixed; right: 16px; bottom: 16px; left: 16px; max-width: 720px; margin: 0 auto;
  padding: 10px 14px; color: var(--bg); background: var(--ink); border-radius: 8px;
}
.status:empty { padding: 0; }

/* Tables, facts, and history. */
table { width: 100%; font-size: 0.9rem; border-collapse: collapse; }
th, td {
  padding: 6px 8px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--line);
  overflow-wrap: anywhere;
}
thead th { color: var(--muted); font-weight: 600; }
.facts {
  display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 16px;
  margin: 0 0 12px;
}
.facts dt { color: var(--muted); }
.facts dd { margin: 0; overflow-wrap: anywhere; }
pre {
  max-height: 480px; margin: 0 0 12px; padding: 12px; overflow: auto; white-space: pre-wrap;
  overflow-wrap: anywhere; background: var(--surface-2); border-radius: 6px;
}
.versions { display: grid; gap: 12px; margin: 0 0 24px; padding: 0; list-style: none; }
.version {
  padding: 12px 16px; background: var(--surface); border: 1px solid var(--line);
  border-radius: 8px;
}
.version.autonomous { border-left: 4px solid var(--accent); }
.version h3 { margin-top: 0; }
details { margin-top: 8px; }
summary { color: var(--accent); cursor: pointer; }
section { margin-top: 32px; }

@media (max-width: 720px) {
  .card { grid-template-columns: minmax(0, 1fr); }
  .dataset { margin-left: 0; }
}
`;

/** Plain JavaScript, served as written: String.raw keeps any backslash as it is. */
export const CONSOLE_SCRIPT = String.raw`'use strict';
(() => {
  /*
   * Spatula's console (ADR 0009): three screens chosen by the address's hash (#questions,
   * #proposals, #history), and a capture view (#capture/<dataset>/<capture>). It calls the
   * console's API on its own origin, behind Cloudflare Access. What it shows came from pages and
   * from people, so it's data, never markup: every node is made with createElement, text goes in
   * as text (textContent, or a string handed to append), attributes go through setAttribute, and a
   * link leaves the console only for an https: address.
   */

  const API = '/console/api';
  const NONE = 'none';
  const SCREENS = ['questions', 'proposals', 'history'];
  const KINDS = ['classify', 'match', 'publication'];
  /** The answers a match question takes besides its own: core's MATCH_RELATIONSHIPS (ADR 0003). */
  const MATCH_ANSWERS = ['same', 'edition', 'spec-version', 'other-model', 'unrelated'];
  const BULK_MAX = 500;
  /** What el() never sets: handlers, addresses, and inline style. */
  const UNSAFE = ['href', 'src', 'srcdoc', 'style', 'action', 'formaction', 'xlink:href'];
  const KIND_WORDS = new Map([
    ['add-category', 'A new category'],
    ['add-subcategory', 'A new subcategory'],
    ['add-function', 'A new function'],
    ['add-feature', 'A new feature'],
    ['add-value', 'A new feature value'],
    ['describe', 'A sharper description'],
    ['rename', 'A rename'],
    ['move', 'A move'],
    ['merge', 'A merge'],
    ['split', 'A split'],
    ['retire', 'A retirement'],
    ['implies', 'What a shelf implies'],
    ['scope', 'The scope statement'],
  ]);
  const ACTION_WORDS = new Map([
    ['answer', 'Answered'],
    ['flag', 'Flagged'],
    ['suggest', 'Suggested'],
    ['accept', 'Accepted'],
    ['edit', 'Edited and accepted'],
    ['reject', 'Rejected'],
    ['apply', 'Applied on its own'],
    ['undo', 'Undid'],
    ['revoke', 'Revoked autonomy'],
  ]);

  const main = document.getElementById('main');
  const picker = document.getElementById('dataset');
  const statusLine = document.getElementById('status');
  const tabs = SCREENS.map((screen) => ({
    screen,
    link: document.getElementById('screen-' + screen),
  }));
  const state = {
    datasets: [],
    dataset: null,
    /** Each dataset's taxonomy as the API gave it, { version, taxonomy }, or null for none. */
    taxonomies: new Map(),
    filters: { kind: '', shelf: '', source: '', below: '' },
  };
  let renders = 0;
  let groups = 0;

  // Nodes, and words.

  /** An element: its attributes through setAttribute, then its children. */
  function el(tag, attributes, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes || {})) {
      if (value === null || value === undefined || value === false) continue;
      const lower = name.toLowerCase();
      if (lower.startsWith('on') || UNSAFE.includes(lower)) {
        throw new Error('The console never sets ' + name + ' this way.');
      }
      node.setAttribute(name, value === true ? '' : String(value));
    }
    add(node, children);
    return node;
  }

  /** Appends children, skipping what's empty and opening lists. A string goes in as text. */
  function add(node, ...children) {
    for (const child of children) {
      if (child === null || child === undefined || child === false) continue;
      if (Array.isArray(child)) add(node, ...child);
      else node.append(typeof child === 'object' ? child : String(child));
    }
  }

  /** A line with a label in bold. */
  function labelled(label, ...value) {
    return el('p', {}, el('strong', {}, label + ': '), value);
  }

  /** An address the console may link to: an https: URL, whole; null for anything else. */
  function safeHref(value) {
    if (typeof value !== 'string') return null;
    let url;
    try {
      url = new URL(value);
    } catch (error) {
      return null;
    }
    return url.protocol === 'https:' ? url.href : null;
  }

  /** A link out to a page, opened apart; the address as text when it isn't https:. */
  function outLink(address) {
    const href = safeHref(address);
    if (href === null) return el('span', { class: 'address' }, text(address));
    const opens = { class: 'address', rel: 'noopener noreferrer', target: '_blank' };
    const link = el('a', opens, address);
    link.setAttribute('href', href);
    return link;
  }

  /** A link to one of the console's own views. */
  function viewLink(parts, label) {
    const link = el('a', {}, label);
    const hash = parts.map((part) => encodeURIComponent(String(part))).join('/');
    link.setAttribute('href', '#' + hash);
    return link;
  }

  function text(value) {
    if (typeof value === 'string') return value;
    return value === null || value === undefined ? '—' : String(value);
  }

  function brief(value) {
    if (value === null || value === undefined || typeof value !== 'object') return text(value);
    const json = JSON.stringify(value);
    return json.length > 300 ? json.slice(0, 299) + '…' : json;
  }

  function when(iso) {
    const written = typeof iso === 'string' && iso.length >= 16;
    return written ? iso.slice(0, 16).replace('T', ' ') + ' UTC' : '—';
  }

  function plural(count, one, many) {
    return count + ' ' + (count === 1 ? one : many);
  }

  function errorText(error) {
    return error && typeof error.message === 'string' ? error.message : String(error);
  }

  function say(message) {
    statusLine.textContent = message;
  }

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function list(value) {
    return Array.isArray(value) ? value : [];
  }

  // The API.

  function path(dataset, rest) {
    return '/datasets/' + encodeURIComponent(dataset) + rest;
  }

  /** Calls the console's API. A refusal throws, in the API's own words. */
  async function api(method, address, body) {
    const init = { method, credentials: 'same-origin', redirect: 'manual', headers: {} };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetch(API + address, init);
    } catch (error) {
      throw new Error('Spatula didn’t answer. Check the connection, then try again.');
    }
    // Access sends a request whose session has ended to its sign-in page.
    if (response.type === 'opaqueredirect' || response.status === 0) {
      throw new Error('Your Access session has ended. Reload the page to sign in again.');
    }
    let data = null;
    try {
      data = await response.json();
    } catch (error) {
      data = null;
    }
    const answer = isObject(data) ? data : {};
    if (!response.ok) {
      const said =
        typeof answer.error === 'string'
          ? answer.error
          : 'Spatula answered HTTP ' + response.status + '.';
      const issues = list(answer.issues).map(String);
      const refused = new Error(issues.length === 0 ? said : said + ' ' + issues.join(' '));
      refused.status = response.status;
      throw refused;
    }
    return answer;
  }

  /** The dataset's current taxonomy, { version, taxonomy }, or null when it has none. */
  async function taxonomyOf(dataset) {
    if (state.taxonomies.has(dataset)) return state.taxonomies.get(dataset);
    let found = null;
    try {
      const got = await api('GET', path(dataset, '/taxonomy'));
      if (isObject(got.taxonomy) && typeof got.version === 'number') found = got;
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    state.taxonomies.set(dataset, found);
    return found;
  }

  // The taxonomy's names. A retired item keeps its name, so an older question still reads.

  function itemsOf(t, subject) {
    if (t === null) return [];
    if (subject === 'shelf') return t.shelves;
    if (subject === 'function') return t.functions;
    if (subject === 'feature') return t.features;
    return t.features.flatMap((feature) => feature.values);
  }

  function find(t, subject, ref) {
    return itemsOf(t, subject).find((item) => item.id === ref || item.slug === ref);
  }

  function nameOf(t, subject, ref) {
    const found = find(t, subject, ref);
    return found === undefined ? text(ref) : found.name;
  }

  /** Whether a shelf answer is none: the API takes the ID "none" and the words. */
  function isNone(ref) {
    return ref === NONE || ref === 'None of these';
  }

  /** A shelf as people read it, "Amplifiers › Power amps", or "None of these". */
  function shelfLabel(t, ref) {
    if (isNone(ref)) return 'None of these';
    const shelf = find(t, 'shelf', ref);
    if (shelf === undefined) return text(ref);
    const parent = shelf.parentId === null ? undefined : find(t, 'shelf', shelf.parentId);
    return parent === undefined ? shelf.name : parent.name + ' › ' + shelf.name;
  }

  /** A feature value with its feature, "Drives: Speakers". */
  function valueLabel(t, ref) {
    const value = find(t, 'value', ref);
    if (value === undefined) return text(ref);
    const feature = t.features.find((one) => one.values.includes(value));
    return feature.name + ': ' + value.name;
  }

  function subjectLabel(t, subject, ref) {
    if (subject === 'shelf') return shelfLabel(t, ref);
    if (subject === 'value') return valueLabel(t, ref);
    return nameOf(t, subject, ref);
  }

  /** The live shelves in their order: each category, then its subcategories. */
  function liveShelves(t) {
    const live = itemsOf(t, 'shelf').filter((shelf) => shelf.retiredIn === null);
    const order = (a, b) => a.sortOrder - b.sortOrder || (a.slug < b.slug ? -1 : 1);
    const under = (id) => live.filter((shelf) => shelf.parentId === id).sort(order);
    return under(null).flatMap((category) => [category, ...under(category.id)]);
  }

  /** A three-part answer in words, with the shelf's probability where it's known. */
  function answerWords(t, answer, chances) {
    if (!isObject(answer)) return '';
    const words = [];
    if (typeof answer.shelf === 'string') {
      const chance = isObject(chances) ? chances['shelf:' + answer.shelf] : undefined;
      const sure = typeof chance === 'number' ? ' (' + chance.toFixed(2) + ')' : '';
      words.push(shelfLabel(t, answer.shelf) + sure);
    }
    const functions = list(answer.functions).map((ref) => nameOf(t, 'function', ref));
    if (functions.length > 0) words.push('functions: ' + functions.join(', '));
    const values = list(answer.values).map((ref) => valueLabel(t, ref));
    if (values.length > 0) words.push(values.join(', '));
    return words.join('; ');
  }

  /** Parts as a person gives them, by slug or ID: a suggestion, or an answer in the log. */
  function givenWords(t, given) {
    if (!isObject(given)) return '';
    if (typeof given.answer === 'string') return given.answer;
    const words = [];
    if (typeof given.shelf === 'string') words.push(shelfLabel(t, given.shelf));
    const functions = list(given.functions).map((ref) => nameOf(t, 'function', ref));
    if (functions.length > 0) words.push('functions: ' + functions.join(', '));
    const features = isObject(given.features) ? given.features : {};
    for (const [feature, values] of Object.entries(features)) {
      const names = list(values).map((ref) => nameOf(t, 'value', ref));
      if (names.length > 0) words.push(nameOf(t, 'feature', feature) + ': ' + names.join(', '));
    }
    return words.length === 0 ? 'none of the parts offered' : words.join('; ');
  }

  /** The decider's probabilities, likeliest first, named as people read them. */
  function chancesList(t, chances, inParts) {
    const label = (key) => {
      if (!inParts) return key;
      const at = key.indexOf(':');
      const kind = key.slice(0, at);
      const ref = key.slice(at + 1);
      if (kind === 'shelf') return shelfLabel(t, ref);
      if (kind === 'function') return nameOf(t, 'function', ref);
      return kind === 'value' ? valueLabel(t, ref) : key;
    };
    const entries = Object.entries(isObject(chances) ? chances : {})
      .filter((entry) => typeof entry[1] === 'number' && Number.isFinite(entry[1]))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12);
    if (entries.length === 0) return null;
    const rows = entries.map(([key, chance]) => {
      const p = Math.min(1, Math.max(0, chance));
      const meter = el('meter', { min: 0, max: 1, value: p }, p.toFixed(2));
      const figure = el('span', { class: 'mono' }, p.toFixed(2));
      return el('li', {}, el('span', {}, label(key)), meter, figure);
    });
    return el('div', {}, el('h4', {}, 'Probabilities'), el('ul', { class: 'chances' }, rows));
  }

  function actorWords(actor) {
    if (!isObject(actor)) return 'Someone';
    const through = typeof actor.client === 'string' ? ' (' + actor.client + ')' : '';
    if (actor.role === 'owner') return 'The owner' + through;
    if (actor.role === 'decider') return 'Spatula' + through;
    if (actor.role === 'reviewer') {
      return 'Reviewer ' + text(actor.reviewer) + ' for ' + text(actor.consumer) + through;
    }
    return text(actor.role) + through;
  }

  // Questions.

  async function questionsScreen(dataset) {
    const known = await taxonomyOf(dataset);
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(state.filters)) {
      if (value !== '') query.set(key, value);
    }
    const search = query.toString() === '' ? '' : '?' + query.toString();
    const listed = await api('GET', path(dataset, '/review' + search));
    const reviews = list(listed.reviews).filter((review) => isObject(review) && review.id);
    const bulk = bulkTools(dataset);
    const cards = reviews.map((review) => questionCard(dataset, known, review, bulk));
    bulk.update();
    const waiting = reviews.length === 0
      ? 'No questions wait for an answer.'
      : plural(reviews.length, 'question waits', 'questions wait') + ' for an answer.';
    return {
      heading: el('h1', { tabindex: '-1' }, 'Questions'),
      body: [
        filtersForm(known === null ? null : known.taxonomy),
        el('p', { class: 'lede' }, waiting),
        bulk.node,
        el('div', { class: 'cards' }, cards),
      ],
    };
  }

  function filtersForm(t) {
    const option = (value, label) => el('option', { value }, label);
    const kind = el('select', {}, option('', 'Every kind'), KINDS.map((one) => option(one, one)));
    const shelves = liveShelves(t).map((one) => option(one.id, shelfLabel(t, one.id)));
    const shelf = el('select', { disabled: t === null }, option('', 'Every shelf'), shelves);
    const source = el('input', { type: 'text', maxlength: 63, autocomplete: 'off' });
    const below = el('input', { type: 'number', min: 0, max: 1, step: 0.05 });
    kind.value = state.filters.kind;
    shelf.value = state.filters.shelf;
    source.value = state.filters.source;
    below.value = state.filters.below;
    const form = el(
      'form',
      { class: 'filters' },
      el('label', {}, 'Kind', kind),
      el('label', {}, 'Shelf', shelf),
      el('label', {}, 'Source', source),
      el('label', {}, 'Proposed with less than', below),
      el('button', { type: 'submit' }, 'Filter'),
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      state.filters = {
        kind: kind.value,
        shelf: shelf.value,
        source: source.value.trim(),
        below: below.value.trim(),
      };
      show(true);
    });
    return form;
  }

  /** Accepting suggestions in bulk: each question that has one offers a box to tick. */
  function bulkTools(dataset) {
    const offered = new Map();
    const accept = el('button', { type: 'button' }, 'Accept the chosen suggestions');
    const every = el('button', { type: 'button', class: 'quiet' }, 'Choose every suggestion');
    const node = el('div', { class: 'bulk' }, accept, every);
    const chosen = () => [...offered].filter((entry) => entry[1].checked).map((entry) => entry[0]);
    const update = () => {
      const count = chosen().length;
      accept.disabled = count === 0;
      accept.textContent = count === 0
        ? 'Accept the chosen suggestions'
        : 'Accept ' + plural(count, 'suggestion', 'suggestions');
      node.hidden = offered.size === 0;
    };
    every.addEventListener('click', () => {
      for (const box of offered.values()) box.checked = true;
      update();
    });
    accept.addEventListener('click', async () => {
      const reviewIds = chosen().slice(0, BULK_MAX);
      accept.disabled = true;
      try {
        const answers = reviewIds.map((reviewId) => ({ reviewId, suggestion: true }));
        const answered = await api('POST', path(dataset, '/review/bulk'), { answers });
        // Each result has the HTTP status its answer would have had: 200 answered, 202 flagged for
        // the owner, and anything else refused, with error saying why.
        const results = list(answered.results).filter(isObject);
        const taken = results.filter((one) => one.status === 200 || one.status === 202);
        const missed = results
          .filter((one) => !taken.includes(one))
          .map((one) => text(one.reviewId) + ': ' + text(one.error || one.status));
        const left = missed.length === 0 ? '' : ' Not taken: ' + missed.join('; ');
        say('Accepted ' + taken.length + ' of ' + reviewIds.length + ' suggestions.' + left);
        await show(true);
      } catch (error) {
        say(errorText(error));
        update();
      }
    });
    return {
      node,
      update,
      offer(reviewId, box) {
        offered.set(reviewId, box);
        box.addEventListener('change', update);
      },
      forget(reviewId) {
        offered.delete(reviewId);
        update();
      },
    };
  }

  function publicationFacts(context) {
    const count = (key) => (typeof context[key] === 'number' ? context[key] : 0);
    const reasons = list(context.reasons).map(String);
    const open = count('openClassify') + count('openMatch');
    const records = count('records') + ' records: ' + count('added') + ' new, ';
    const questions = count('openClassify') + ' classify, ' + count('openMatch') + ' match';
    return [
      el('p', {}, records + count('removed') + ' removed.'),
      reasons.length > 0 ? el('p', {}, 'Held because ' + reasons.join('; ') + '.') : null,
      count('incomplete') > 0
        ? el('p', {}, 'Left out as incomplete: ' + count('incomplete') + '.')
        : null,
      open > 0 ? el('p', {}, 'Open questions: ' + questions + '.') : null,
    ];
  }

  function questionCard(dataset, known, review, bulk) {
    const t = known === null ? null : known.taxonomy;
    const context = isObject(review.context) ? review.context : {};
    const question = isObject(review.question) ? review.question : {};
    const inParts = question.type === 'taxonomy';
    const card = el('article', { class: review.flagged === true ? 'card flagged' : 'card' });
    const evidence = el('div', { class: 'evidence' }, el('p', {}, text(question.prompt)));
    const problem = el('p', { class: 'error', role: 'alert' });
    const done = (answered) => {
      const effect = typeof answered.effect === 'string' ? answered.effect : '';
      const verb = typeof answered.flagged === 'string' ? 'Flagged ' : 'Answered ';
      const said = verb + review.id + '.' + (effect === '' ? '' : ' ' + effect);
      const line = el('p', { class: 'done', tabindex: '-1' }, said);
      card.replaceChildren(line);
      bulk.forget(review.id);
      line.focus();
    };

    if (review.kind === 'classify') add(evidence, el('p', {}, 'Page: ', outLink(context.url)));
    if (review.kind === 'match') {
      const record =
        typeof context.record === 'string' ? context.record + ', which stands for ' : '';
      add(
        evidence,
        el('p', {}, 'Page: ', outLink(context.page)),
        el('p', {}, 'Record: ', record, outLink(context.entity)),
      );
    }
    if (review.kind === 'publication') add(evidence, publicationFacts(context));
    if (typeof context.captureId === 'string' && context.captureId !== '') {
      const where = ['capture', dataset, context.captureId];
      add(evidence, el('p', {}, viewLink(where, 'The page as Spatula saw it')));
    }
    if (review.flagged === true) {
      add(evidence, el('p', { class: 'flag' },
        'Flagged: a reviewer’s answer differs from the one that stood. Your answer closes it.'));
    }
    if (inParts) {
      const asked = typeof context.version === 'number' ? context.version : null;
      if (known !== null && asked !== null && asked !== known.version) {
        add(evidence, el('p', { class: 'meta' }, 'Asked under taxonomy version ' + asked +
          '; it’s at version ' + known.version + ' now.'));
      }
      const proposed = answerWords(t, context.proposed, context.probabilities);
      const settled = answerWords(t, context.settled, null);
      const earlier = answerWords(t, context.earlier, null);
      add(evidence, labelled('Proposed', proposed === '' ? 'nothing' : proposed));
      if (settled !== '') add(evidence, labelled('Settled already', settled));
      if (earlier !== '') add(evidence, labelled('A person said before', earlier));
    } else if (typeof context.proposed === 'string' && context.proposed !== '') {
      add(evidence, labelled('Proposed', context.proposed));
    }
    if (typeof context.reason === 'string' && context.reason !== '') {
      add(evidence, labelled('Why', context.reason));
    }
    add(evidence, chancesList(t, context.probabilities, inParts));
    if (isObject(review.suggestion)) {
      const take = el('button', { type: 'button' }, 'Accept its suggestion');
      const pick = el('input', { type: 'checkbox' });
      bulk.offer(review.id, pick);
      take.addEventListener('click', () =>
        send(dataset, review, { suggestion: true }, [take], problem, done));
      add(evidence, el(
        'div',
        { class: 'suggestion' },
        labelled('Suggested', givenWords(t, review.suggestion)),
        el('div', { class: 'row' }, take, el('label', { class: 'tick' }, pick, 'Accept in bulk')),
      ));
    }

    const answer = inParts
      ? partsForm(dataset, t, review, context, problem, done)
      : optionsForm(dataset, review, problem, done);
    const about = review.kind === 'match'
      ? context.page
      : review.kind === 'publication' ? 'Snapshot ' + text(context.snapshotId) : context.url;
    add(
      card,
      el('h2', {}, text(about)),
      el('p', { class: 'meta mono' }, review.kind + ' · ' + review.id),
      el('p', { class: 'meta' }, 'Asked ' + when(review.createdAt)),
      evidence,
      el('div', { class: 'answer' }, answer, problem),
    );
    return card;
  }

  /** A taxonomy question's controls: its shelf, its functions, and its features' values. */
  function partsForm(dataset, t, review, context, problem, done) {
    const parts = isObject(review.question.parts) ? review.question.parts : {};
    const proposed = isObject(context.proposed) ? context.proposed : {};
    const form = el('form', { class: 'parts' });

    let shelf = null;
    const shelves = list(parts.shelves);
    if (shelves.length > 0) {
      const options = shelves.map((ref) => el('option', { value: ref }, shelfLabel(t, ref)));
      const choose = el('option', { value: '' }, 'Choose a shelf');
      shelf = el('select', { required: true }, choose, options);
      if (shelves.includes(proposed.shelf)) shelf.value = proposed.shelf;
      add(form, el('label', { class: 'part' }, el('span', {}, 'Shelf'), shelf));
    }

    // What a page that is none of these can't take: its functions and its features' values. They
    // are hidden while the shelf is none, and a none answer sends none of them.
    const shelfBound = [];
    const ticked = [];
    const functions = list(parts.functions);
    if (functions.length > 0) {
      const set = el('fieldset', {}, el('legend', {}, 'What it does beyond its shelf'));
      shelfBound.push(set);
      for (const ref of functions) {
        const box = el('input', { type: 'checkbox' });
        box.checked = list(proposed.functions).includes(ref);
        ticked.push({ ref, box });
        add(set, el('label', { class: 'tick' }, box, nameOf(t, 'function', ref)));
      }
      add(form, set);
    }

    const chosen = [];
    const features = isObject(parts.features) ? parts.features : {};
    for (const [feature, offered] of Object.entries(features)) {
      if (list(offered).length === 0) continue;
      const found = find(t, 'feature', feature);
      const one = found !== undefined && found.cardinality === 'one';
      groups += 1;
      const group = 'choice-' + groups;
      const legend = nameOf(t, 'feature', feature) + (one ? ': one of' : ': any of');
      const set = el('fieldset', {}, el('legend', {}, legend));
      shelfBound.push(set);
      if (one) {
        const none = el('input', { type: 'radio', name: group });
        none.checked = !offered.some((ref) => list(proposed.values).includes(ref));
        add(set, el('label', { class: 'tick' }, none, 'None of these'));
      }
      for (const ref of offered) {
        const input = el('input', { type: one ? 'radio' : 'checkbox', name: one ? group : null });
        input.checked = list(proposed.values).includes(ref);
        chosen.push({ feature, ref, input });
        add(set, el('label', { class: 'tick' }, input, nameOf(t, 'value', ref)));
      }
      add(form, set);
    }

    const none = () => shelf !== null && isNone(shelf.value);
    const sync = () => {
      for (const set of shelfBound) set.hidden = none();
    };
    if (shelf !== null) shelf.addEventListener('change', sync);
    sync();

    const note = el('textarea', { rows: 2, maxlength: 500 });
    const submit = el('button', { type: 'submit' }, 'Answer');
    add(form, el('label', { class: 'part' }, el('span', {}, 'Note, if any'), note), submit);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      problem.textContent = '';
      const given = {};
      if (shelf !== null) {
        if (shelf.value === '') {
          problem.textContent = 'Choose the shelf: this question asks for it.';
          return;
        }
        given.shelf = shelf.value;
      }
      // None of these takes no functions and no values: the API refuses a none answer with them.
      if (!none()) {
        if (ticked.length > 0) {
          given.functions = ticked.filter((entry) => entry.box.checked).map((entry) => entry.ref);
        }
        const values = new Map();
        for (const entry of chosen.filter((one) => one.input.checked)) {
          values.set(entry.feature, [...(values.get(entry.feature) || []), entry.ref]);
        }
        if (values.size > 0) given.features = Object.fromEntries(values);
      }
      const body = { parts: given };
      if (note.value.trim() !== '') body.note = note.value.trim();
      send(dataset, review, body, [submit], problem, done);
    });
    return form;
  }

  /** A question answered with one of its options: a classification, a match, a publication. */
  function optionsForm(dataset, review, problem, done) {
    const question = review.question;
    const own = question.type === 'boolean'
      ? ['true', 'false']
      : list(question.type === 'score' ? question.levels : question.options);
    // A match question asked before the relationships takes them too, as reviewAnswers has it.
    const options = review.kind === 'match' ? [...new Set([...own, ...MATCH_ANSWERS])] : own;
    const buttons = [];
    for (const option of options) {
      const quiet = option === 'discard' || option === 'None of these';
      const button = el('button', { type: 'button', class: quiet ? 'quiet' : null }, option);
      button.addEventListener('click', () =>
        send(dataset, review, { answer: option }, buttons, problem, done));
      buttons.push(button);
    }
    return el('div', { class: 'options' }, buttons);
  }

  async function send(dataset, review, body, controls, problem, done) {
    problem.textContent = '';
    for (const control of controls) control.disabled = true;
    try {
      done(await api('POST', path(dataset, '/review/' + encodeURIComponent(review.id)), body));
    } catch (error) {
      problem.textContent = errorText(error);
      for (const control of controls) control.disabled = false;
    }
  }

  // Proposals.

  async function proposalsScreen(dataset) {
    const known = await taxonomyOf(dataset);
    const heading = el('h1', { tabindex: '-1' }, 'Proposals');
    if (known === null) {
      const none = el('p', {}, dataset + ' has no taxonomy yet, so nothing is proposed.');
      return { heading, body: [none] };
    }
    const [listed, earned] = await Promise.all([
      api('GET', path(dataset, '/proposals?status=open')),
      api('GET', path(dataset, '/autonomy')),
    ]);
    const proposals = list(listed.proposals).filter((one) => isObject(one) && one.id);
    const t = known.taxonomy;
    const waiting = proposals.length === 0
      ? 'No proposal waits.'
      : plural(proposals.length, 'proposal waits.', 'proposals wait.');
    return {
      heading,
      body: [
        el('p', { class: 'lede' }, 'Taxonomy version ' + known.version + '. ' + waiting),
        el('div', { class: 'cards' }, proposals.map((one) => proposalCard(dataset, t, one))),
        autonomySection(dataset, earned),
      ],
    };
  }

  function changeTitle(t, change) {
    const item = (subject, ref) => subjectLabel(t, subject, ref);
    switch (change.kind) {
      case 'add-category':
        return 'Add the category ' + text(change.name);
      case 'add-subcategory':
        return 'Add ' + text(change.name) + ' under ' + shelfLabel(t, change.parent);
      case 'add-function':
        return 'Add the function ' + text(change.name);
      case 'add-feature':
        return 'Add the feature ' + text(change.name);
      case 'add-value':
        return 'Add ' + text(change.name) + ' to ' + nameOf(t, 'feature', change.feature);
      case 'describe':
        return 'Describe ' + item(change.subject, change.item) + ' anew';
      case 'rename':
        return 'Rename ' + item(change.subject, change.item) + ' ' + text(change.name);
      case 'move':
        return 'Move ' + shelfLabel(t, change.item) + ' under ' + shelfLabel(t, change.parent);
      case 'merge':
        return 'Merge ' + item(change.subject, change.from) + ' into ' +
          item(change.subject, change.into);
      case 'split':
        return 'Split ' + shelfLabel(t, change.item) + ' into subcategories';
      case 'retire':
        return 'Retire ' + item(change.subject, change.item);
      case 'implies':
        return 'Change what ' + shelfLabel(t, change.shelf) + ' implies';
      case 'scope':
        return 'Change the scope statement';
      default:
        return 'A change';
    }
  }

  /** The change as rows of what, before, and after. */
  function diffRows(t, change) {
    const fns = (refs) =>
      list(refs).map((ref) => nameOf(t, 'function', ref)).join(', ') || 'nothing';
    const names = (entries) => list(entries).map((one) => text(isObject(one) ? one.name : one));
    switch (change.kind) {
      case 'add-category':
      case 'add-subcategory':
      case 'add-function':
      case 'add-value': {
        const rows = [
          ['Name', '—', text(change.name)],
          ['Slug', '—', text(change.slug)],
          ['Description', '—', text(change.description)],
        ];
        if (change.kind === 'add-category' || change.kind === 'add-subcategory') {
          rows.push(['Implies', '—', fns(change.implies)]);
          rows.push(['In scope as', '—', text(change.scopeClause)]);
        }
        return rows;
      }
      case 'add-feature':
        return [
          ['Name', '—', text(change.name)],
          ['Description', '—', text(change.description)],
          ['Takes', '—', change.cardinality === 'one' ? 'one value' : 'any of its values'],
          ['On shelves', '—', list(change.shelves).map((ref) => shelfLabel(t, ref)).join(', ')],
          ['Values', '—', names(change.values).join(', ')],
        ];
      case 'describe': {
        const found = find(t, change.subject, change.item);
        const before = found === undefined ? '—' : found.description;
        return [['Description', before, text(change.description)]];
      }
      case 'rename': {
        const found = find(t, change.subject, change.item);
        const rows = [['Name', found === undefined ? '—' : found.name, text(change.name)]];
        if (typeof change.slug === 'string') {
          rows.push(['Slug', found === undefined ? '—' : found.slug, change.slug]);
        }
        return rows;
      }
      case 'move': {
        const found = find(t, 'shelf', change.item);
        const before = found === undefined || found.parentId === null
          ? 'none: a category'
          : shelfLabel(t, found.parentId);
        return [['Category', before, shelfLabel(t, change.parent)]];
      }
      case 'merge': {
        const from = subjectLabel(t, change.subject, change.from);
        const into = subjectLabel(t, change.subject, change.into);
        return [['Items', from + ' and ' + into, into]];
      }
      case 'split':
        return [['Subcategories', 'none', names(change.children).join(', ')]];
      case 'retire':
        return [['Status', 'live', 'retired']];
      case 'implies': {
        const found = find(t, 'shelf', change.shelf);
        return [['Implies', found === undefined ? '—' : fns(found.implies), fns(change.implies)]];
      }
      case 'scope':
        return [['Scope', t === null ? '—' : t.scope, text(change.scope)]];
      default:
        return [];
    }
  }

  function diffTable(t, change) {
    const rows = diffRows(t, change);
    if (rows.length === 0) return el('pre', {}, JSON.stringify(change, null, 2));
    const head = ['What', 'Before', 'After'].map((label) => el('th', { scope: 'col' }, label));
    const body = rows.map((row) =>
      el('tr', {}, el('th', { scope: 'row' }, row[0]), el('td', {}, row[1]), el('td', {}, row[2])));
    const thead = el('thead', {}, el('tr', {}, head));
    return el('table', { class: 'diff' }, thead, el('tbody', {}, body));
  }

  /** An evidence page: its address as a link, then its title and the shelf it sits on, as text. */
  function evidencePage(t, page) {
    if (!isObject(page)) return text(page);
    const shelf = typeof page.shelf === 'string' ? shelfLabel(t, page.shelf) : null;
    const facts = [typeof page.title === 'string' ? page.title : null, shelf]
      .filter((fact) => fact !== null && fact !== '')
      .join(' · ');
    return [outLink(page.address), facts === '' ? null : ' — ' + facts];
  }

  function evidenceList(t, evidence) {
    if (!isObject(evidence)) return null;
    const items = Object.entries(evidence).map(([key, value]) => {
      if (key !== 'pages' || !Array.isArray(value)) return el('li', {}, key + ': ' + brief(value));
      const pages = value.slice(0, 20).map((page) => el('li', {}, evidencePage(t, page)));
      return el('li', {}, 'Pages:', el('ul', {}, pages));
    });
    return el('div', {}, el('h4', {}, 'Evidence'), el('ul', {}, items));
  }

  function migrationWords(t, migration) {
    if (!isObject(migration)) return '';
    const from = subjectLabel(t, migration.subject, migration.from);
    switch (migration.kind) {
      case 'merge':
        return 'Merge ' + from + ' into ' + subjectLabel(t, migration.subject, migration.to) +
          ': its values move there.';
      case 'split': {
        // A preview names the shelves it would create by slug, not by an ID, so they're shown as
        // the text they are: nothing here parses a migration.
        const into = list(migration.to).map(String).join(', ');
        return 'Split ' + from + ' into ' + into + ': its pages stay, and each gets a' +
          ' subcategory question.';
      }
      case 'retire':
        return 'Retire ' + from + ': its pages are decided again, and a person’s answer reopens.';
      case 'restore':
        return 'Bring back ' + from + ': records point to it again through their own values.';
      default:
        return text(migration.kind) + ' ' + from + ': the ID stays, so nothing moves.';
    }
  }

  function impactList(t, impact) {
    if (!isObject(impact)) return null;
    const count = (key) => (typeof impact[key] === 'number' ? impact[key] : 0);
    // Each move says how many pages it takes along, so the pages that move are their sum.
    const moved = list(impact.moves)
      .filter(isObject)
      .reduce((sum, move) => sum + (typeof move.pages === 'number' ? move.pages : 0), 0);
    const migration = list(impact.migration);
    return el(
      'div',
      {},
      el('h4', {}, 'Impact'),
      el(
        'ul',
        {},
        el('li', {}, 'Pages decided again: ' + count('pagesToRedecide')),
        el('li', {}, 'Pages that move: ' + moved),
        el('li', {}, 'Questions it settles or opens: ' + count('questions')),
        el('li', {}, 'Records that leave the snapshot: ' + count('leaving')),
        el('li', {}, 'Tokens to decide again: ' + count('tokens')),
      ),
      el('h4', {}, 'Migration'),
      migration.length === 0
        ? el('p', {}, 'None: no value moves.')
        : el('ul', {}, migration.map((one) => el('li', {}, migrationWords(t, one)))),
    );
  }

  function proposalCard(dataset, t, proposal) {
    const change = isObject(proposal.change) ? proposal.change : {};
    const card = el('article', { class: 'card' });
    const kind = KIND_WORDS.get(change.kind) || text(change.kind);
    add(
      card,
      el('h2', {}, changeTitle(t, change)),
      el('p', { class: 'meta mono' }, [kind, proposal.id, when(proposal.createdAt)].join(' · ')),
      el(
        'div',
        { class: 'evidence' },
        diffTable(t, change),
        typeof proposal.why === 'string' ? labelled('Why', proposal.why) : null,
        evidenceList(t, proposal.evidence),
        impactList(t, proposal.impact),
      ),
      decisionControls(dataset, proposal, change, card),
    );
    return card;
  }

  function decisionControls(dataset, proposal, change, card) {
    const problem = el('p', { class: 'error', role: 'alert' });
    const accept = el('button', { type: 'button' }, 'Accept');
    const reject = el('button', { type: 'button', class: 'quiet' }, 'Reject');
    const edited = el('textarea', { rows: 8, spellcheck: 'false', class: 'mono' });
    const note = el('input', { type: 'text', maxlength: 500 });
    const acceptEdited = el('button', { type: 'submit' }, 'Accept as edited');
    edited.value = JSON.stringify(change, null, 2);
    const editForm = el(
      'form',
      { class: 'edit' },
      el('label', { class: 'part' }, el('span', {}, 'The change, as JSON'), edited),
      el('label', { class: 'part' }, el('span', {}, 'Note, if any'), note),
      acceptEdited,
    );
    const controls = [accept, reject, acceptEdited];
    const decide = async (body) => {
      problem.textContent = '';
      for (const control of controls) control.disabled = true;
      try {
        const address = path(dataset, '/proposals/' + encodeURIComponent(proposal.id));
        const decided = await api('POST', address, body);
        state.taxonomies.delete(dataset);
        const said =
          typeof decided.version === 'number'
            ? 'Applied: the taxonomy is at version ' + decided.version + ' now.'
            : body.decision === 'reject' ? 'Rejected.' : 'Done.';
        const line = el('p', { class: 'done', tabindex: '-1' }, said);
        card.replaceChildren(line);
        line.focus();
      } catch (error) {
        problem.textContent = errorText(error);
        for (const control of controls) control.disabled = false;
      }
    };
    accept.addEventListener('click', () => decide({ decision: 'accept' }));
    reject.addEventListener('click', () => decide({ decision: 'reject' }));
    editForm.addEventListener('submit', (event) => {
      event.preventDefault();
      let parsed;
      try {
        parsed = JSON.parse(edited.value);
      } catch (error) {
        problem.textContent = 'The change isn’t JSON.';
        return;
      }
      const body = { decision: 'edit', change: parsed };
      if (note.value.trim() !== '') body.note = note.value.trim();
      decide(body);
    });
    return el(
      'div',
      { class: 'decide' },
      el('div', { class: 'row' }, accept, reject),
      el('details', {}, el('summary', {}, 'Edit, then accept'), editForm),
      problem,
    );
  }

  /**
   * Autonomy as the API gives it: after, the acceptances in a row that earn a kind its autonomy,
   * and kinds, each kind that can earn it with its run so far.
   */
  function autonomySection(dataset, answer) {
    const after = typeof answer.after === 'number' ? answer.after : null;
    const rows = list(answer.kinds).filter((row) => isObject(row) && typeof row.kind === 'string');
    const head = ['Kind', 'Accepted in a row', 'Now', 'Revoke'].map((label) =>
      el('th', { scope: 'col' }, label));
    const body = rows.map((row) => {
      const streak = typeof row.streak === 'number' ? row.streak : 0;
      // The API says whether a kind has earned it; failing that, its run against the count.
      const earned =
        typeof row.earned === 'boolean' ? row.earned : after !== null && streak >= after;
      return el(
        'tr',
        {},
        el('th', { scope: 'row' }, KIND_WORDS.get(row.kind) || row.kind),
        el('td', { class: 'mono' }, String(streak)),
        el('td', {}, earned ? 'Applies on its own' : 'Waits for you'),
        el('td', {}, streak > 0 ? revokeControl(dataset, row.kind) : '—'),
      );
    });
    const rule = after === null
      ? 'A kind applies on its own once you’ve accepted enough of its proposals in a row'
      : 'A kind applies on its own once you’ve accepted ' + after + ' of its proposals in a row';
    return el(
      'section',
      {},
      el('h2', {}, 'Autonomy'),
      el('p', { class: 'lede' }, rule + ' unedited. An edit or a rejection starts its count' +
        ' again.'),
      rows.length === 0
        ? el('p', {}, 'The API lists no kind that can earn it.')
        : el('table', {}, el('thead', {}, el('tr', {}, head)), el('tbody', {}, body)),
    );
  }

  function revokeControl(dataset, kind) {
    const problem = el('p', { class: 'error', role: 'alert' });
    const confirm = el('button', { type: 'button', class: 'quiet' }, 'Revoke it');
    confirm.addEventListener('click', async () => {
      confirm.disabled = true;
      problem.textContent = '';
      try {
        await api('POST', path(dataset, '/autonomy/' + encodeURIComponent(kind) + '/revoke'), {});
        say((KIND_WORDS.get(kind) || kind) + ': its count is back to zero.');
        await show(true);
      } catch (error) {
        problem.textContent = errorText(error);
        confirm.disabled = false;
      }
    });
    const warning = el('p', {}, 'Its count starts again from zero.');
    return el('details', {}, el('summary', {}, 'Revoke'), warning, confirm, problem);
  }

  // History.

  async function historyScreen(dataset) {
    const known = await taxonomyOf(dataset);
    const t = known === null ? null : known.taxonomy;
    const [history, log] = await Promise.all([
      known === null ? Promise.resolve({}) : api('GET', path(dataset, '/taxonomy/versions')),
      api('GET', path(dataset, '/review/log')),
    ]);
    const versions = list(history.versions).filter((one) => isObject(one) && one.version > 0);
    const undone = new Set(versions.map((one) => one.undoes).filter((n) => typeof n === 'number'));
    const actions = list(log.actions).filter(isObject);
    const replacing = el('div', { class: 'cards' });
    const replace = (action) => replaceControl(dataset, known, action, replacing);
    return {
      heading: el('h1', { tabindex: '-1' }, 'History'),
      body: [
        el('h2', {}, 'Taxonomy versions'),
        versions.length === 0
          ? el('p', {}, known === null ? dataset + ' has no taxonomy yet.' : 'No version yet.')
          : el('ol', { class: 'versions', reversed: true },
              versions.map((one) => versionItem(dataset, one, undone))),
        el('h2', {}, 'Answers and changes, by who made them'),
        actions.length === 0 ? el('p', {}, 'Nothing is logged yet.') : logTable(t, actions, replace),
        replacing,
      ],
    };
  }

  function versionItem(dataset, version, undone) {
    const changes = list(version.changes);
    const notes = [when(version.createdAt), actorWords(version.actor)];
    if (version.autonomous === true) notes.push('applied on its own');
    if (typeof version.undoes === 'number') notes.push('undoes version ' + version.undoes);
    if (undone.has(version.version)) notes.push('undone');
    const summary = (change) =>
      isObject(change) && typeof change.summary === 'string' ? change.summary : 'A change';
    const summaries = changes.map((change) => el('li', {}, summary(change)));
    const item = el(
      'li',
      { class: version.autonomous === true ? 'version autonomous' : 'version' },
      el('h3', {}, 'Version ' + version.version),
      el('p', { class: 'meta' }, notes.join(' · ')),
      changes.length > 0
        ? el('ul', {}, summaries)
        : el('p', {}, version.version === 1 ? 'The seed.' : 'No change is listed.'),
    );
    if (version.version > 1 && !undone.has(version.version)) {
      add(item, undoControl(dataset, version));
    }
    return item;
  }

  function undoControl(dataset, version) {
    const problem = el('p', { class: 'error', role: 'alert' });
    const confirm = el('button', { type: 'button' }, 'Undo version ' + version.version);
    confirm.addEventListener('click', async () => {
      confirm.disabled = true;
      problem.textContent = '';
      try {
        const address = path(dataset, '/taxonomy/versions/' + version.version + '/undo');
        const undoing = await api('POST', address, {});
        state.taxonomies.delete(dataset);
        say(typeof undoing.version === 'number'
          ? 'Version ' + undoing.version + ' undoes version ' + version.version + '.'
          : 'Version ' + version.version + ' is undone.');
        await show(true);
      } catch (error) {
        problem.textContent = errorText(error);
        confirm.disabled = false;
      }
    });
    // Undoing a merge or a retirement restores the item; a restore's inverse is a retirement.
    const restores = list(version.changes).some((change) =>
      isObject(change) && isObject(change.change) && change.change.kind === 'restore');
    const warning = el('p', {}, 'A new version reverses it, with its migration; history stays' +
      ' as it was.' + (version.autonomous === true ? ' Its kind loses its autonomy.' : '') +
      (restores ? ' Undoing a restore retires the item again: an undone merge isn’t merged' +
        ' again, so answers about the item reopen.' : ''));
    return el('details', {}, el('summary', {}, 'Undo'), warning, confirm, problem);
  }

  function detailWords(t, detail) {
    if (!isObject(detail)) return detail === null || detail === undefined ? '' : String(detail);
    const words = [];
    if (typeof detail.answer === 'string') words.push(detail.answer);
    if (isObject(detail.parts)) words.push(givenWords(t, detail.parts));
    if (typeof detail.note === 'string' && detail.note !== '') words.push('Note: ' + detail.note);
    return words.length > 0 ? words.join(' · ') : brief(detail);
  }

  function logTable(t, actions, replace) {
    const head = ['When', 'Who', 'What', 'About', 'Detail'].map((label) =>
      el('th', { scope: 'col' }, label));
    const rows = actions.map((action) =>
      el(
        'tr',
        {},
        el('td', { class: 'mono' }, when(action.at)),
        el('td', {}, actorWords(action.actor)),
        el('td', {}, ACTION_WORDS.get(action.action) || text(action.action)),
        el('td', { class: 'mono' }, text(action.subject)),
        el('td', {}, detailWords(t, action.detail), replace(action)),
      ));
    return el('table', {}, el('thead', {}, el('tr', {}, head)), el('tbody', {}, rows));
  }

  /**
   * A reviewer's answer, which the owner can replace (ADR 0009): its question, shown as on the
   * questions screen, whose answer reopens it and answers it at once.
   */
  function replaceControl(dataset, known, action, holder) {
    const reviewer = isObject(action.actor) && action.actor.role === 'reviewer';
    const subject = typeof action.subject === 'string' ? action.subject : '';
    if (action.action !== 'answer' || !reviewer || !subject.startsWith('rv_')) return null;
    const open = el('button', { type: 'button', class: 'quiet' }, 'Answer it yourself');
    open.addEventListener('click', async () => {
      open.disabled = true;
      try {
        const got = await api('GET', path(dataset, '/review/' + encodeURIComponent(subject)));
        const review = isObject(got.review) ? got.review : null;
        if (review === null) throw new Error('Spatula didn’t send the question.');
        const unbulked = { offer() {}, forget() {}, update() {} };
        const said = el('p', { class: 'flag', tabindex: '-1' }, 'A reviewer answered ' +
          subject + ': ' + answeredWords(known === null ? null : known.taxonomy, review.answer) +
          '. Your different answer replaces theirs.');
        holder.replaceChildren(said, questionCard(dataset, known, review, unbulked));
        said.focus();
      } catch (error) {
        say(errorText(error));
      } finally {
        open.disabled = false;
      }
    });
    return el('div', {}, open);
  }

  /** A closed question's answer: one of its options, or a taxonomy answer's parts. */
  function answeredWords(t, answer) {
    if (typeof answer !== 'string') return 'nothing';
    try {
      const parts = JSON.parse(answer);
      if (isObject(parts)) return answerWords(t, parts, null) || 'none of the parts offered';
    } catch (error) {
      // Not a taxonomy answer: an option, as it is.
    }
    return answer;
  }

  // A capture.

  function fact(label, value) {
    return [el('dt', {}, label), el('dd', {}, value)];
  }

  function bytes(value) {
    if (typeof value !== 'number') return '—';
    return value >= 1024 ? Math.round(value / 1024) + ' KB' : value + ' bytes';
  }

  async function captureScreen(dataset, captureId) {
    const got = await api('GET', path(dataset, '/captures/' + encodeURIComponent(captureId)));
    const capture = isObject(got.capture) ? got.capture : {};
    const read = isObject(got.read) ? got.read : null;
    const signals = Object.entries(isObject(capture.signals) ? capture.signals : {})
      .map((entry) => entry[0] + '=' + text(entry[1]))
      .join(', ');
    const body = [
      viewLink(['questions'], 'Back to the questions'),
      el('p', { class: 'lede' }, 'Captures are private evidence, shown to you alone. Nothing in' +
        ' them runs here; a link opens the site itself.'),
      el(
        'dl',
        { class: 'facts' },
        fact('Address', outLink(capture.url)),
        fact('After redirects', outLink(capture.finalUrl)),
        fact('Fetched', when(capture.fetchedAt)),
        fact('HTTP status', text(capture.httpStatus)),
        fact('Size', bytes(capture.bytes) + ', stored as ' + bytes(capture.storedBytes)),
        fact('Content hash', el('span', { class: 'mono' }, text(capture.contentHash))),
        fact('ETag', text(capture.etag)),
        fact('Last-Modified', text(capture.lastModified)),
        fact('Content Signals', signals === '' ? '—' : signals),
      ),
    ];
    if (read === null) {
      body.push(el('p', {}, 'Spatula can’t read this page any more: its stored copy is gone.'));
    } else {
      const meta = Object.entries(isObject(read.meta) ? read.meta : {});
      body.push(
        el('h2', {}, 'What Spatula read'),
        el(
          'dl',
          { class: 'facts' },
          fact('Title', text(read.title)),
          fact('Canonical address', outLink(read.canonicalUrl)),
          fact('Breadcrumbs', list(read.breadcrumbs).map(String).join(' › ') || '—'),
        ),
        el('h3', {}, 'Meta tags'),
        meta.length === 0
          ? el('p', {}, 'None.')
          : el('dl', { class: 'facts' }, meta.map((entry) =>
              fact(entry[0], list(entry[1]).join(' | ')))),
        el('h3', {}, 'Structured data'),
        el('pre', {}, JSON.stringify(list(read.jsonLd), null, 2).slice(0, 100000)),
        el('h3', {}, 'Text'),
        el('pre', {}, text(read.text).slice(0, 200000)),
      );
    }
    return { heading: el('h1', { tabindex: '-1' }, 'The page as Spatula saw it'), body };
  }

  // Screens.

  function decodePart(part) {
    try {
      return decodeURIComponent(part);
    } catch (error) {
      return '';
    }
  }

  async function show(focus) {
    renders += 1;
    const ticket = renders;
    const [screen, dataset, captureId] = location.hash.slice(1).split('/').map(decodePart);
    let name = SCREENS.includes(screen) ? screen : 'questions';
    let build;
    if (screen === 'capture' && dataset && captureId) {
      name = 'capture';
      if (state.datasets.some((one) => one.id === dataset)) {
        state.dataset = dataset;
        picker.value = dataset;
      }
      build = () => captureScreen(dataset, captureId);
    } else if (state.dataset === null) {
      const nothing = el('p', {}, 'Spatula keeps no dataset yet.');
      const heading = el('h1', { tabindex: '-1' }, 'No datasets');
      build = async () => ({ heading, body: [nothing] });
    } else {
      const chosen = state.dataset;
      build = () =>
        name === 'proposals'
          ? proposalsScreen(chosen)
          : name === 'history' ? historyScreen(chosen) : questionsScreen(chosen);
    }
    for (const tab of tabs) {
      if (tab.screen === name) tab.link.setAttribute('aria-current', 'page');
      else tab.link.removeAttribute('aria-current');
    }
    main.setAttribute('aria-busy', 'true');
    let built;
    try {
      built = await build();
    } catch (error) {
      const said = el('p', { class: 'error', role: 'alert' }, errorText(error));
      built = { heading: el('h1', { tabindex: '-1' }, 'Something went wrong'), body: [said] };
    }
    // A later navigation has drawn its own screen meanwhile.
    if (ticket !== renders) return;
    main.removeAttribute('aria-busy');
    main.replaceChildren(built.heading);
    add(main, built.body);
    if (focus) built.heading.focus();
  }

  async function start() {
    picker.addEventListener('change', () => {
      state.dataset = picker.value;
      state.filters = { kind: '', shelf: '', source: '', below: '' };
      if (location.hash.startsWith('#capture/')) location.hash = '#questions';
      else show(true);
    });
    window.addEventListener('hashchange', () => show(true));
    try {
      const listed = await api('GET', '/datasets');
      const rows = list(listed.datasets).filter(isObject);
      state.datasets = rows.filter((one) => typeof one.id === 'string');
    } catch (error) {
      main.replaceChildren(el('p', { class: 'error', role: 'alert' }, errorText(error)));
      return;
    }
    picker.replaceChildren();
    add(picker, state.datasets.map((one) => el('option', { value: one.id }, one.id)));
    if (state.datasets.length > 0) {
      state.dataset = state.datasets[0].id;
      picker.value = state.dataset;
    }
    await show(false);
  }

  start();
})();
`;
