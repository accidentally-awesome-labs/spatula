#!/usr/bin/env node
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';

const API_URL = (process.env.SPATULA_API_URL ?? 'http://127.0.0.1:3100').replace(/\/+$/, '');
const MODEL = process.env.SP_LIVE_MODEL ?? process.env.SP_E2E_MODEL ?? 'deepseek/deepseek-v4-flash';
const PROFILE = process.env.SP_LIVE_PROFILE ?? 'broad';
const POLL_MS = numberEnv('SP_LIVE_POLL_MS', 5_000);
const MAX_WAIT_MS = numberEnv('SP_LIVE_MAX_WAIT_MS', 900_000);
const EXPORT_WAIT_MS = numberEnv('SP_LIVE_EXPORT_WAIT_MS', 180_000);
const CRAWLER = process.env.SP_LIVE_CRAWLER ?? 'firecrawl';
const REPORT_PATH = process.env.SP_LIVE_REPORT_PATH;
const LOCAL_WEBHOOK_DISABLED = process.env.SP_LIVE_DISABLE_LOCAL_WEBHOOK === '1';

const args = new Set(process.argv.slice(2));

const CASES = [
  {
    id: 'books_product_cards',
    label: 'Books product cards',
    category: 'repeated-card-catalog',
    seedUrl: 'https://books.toscrape.com/',
    description:
      'Extract a book catalog. For each book card, gather title, price, availability, rating, and product URL. Return one record per book.',
    minEntities: 20,
    minFieldHits: 20,
    requiredFields: ['title', 'price', 'rating', 'product_url'],
    startMode: 'patch',
    sse: true,
    webhook: true,
    exports: ['json', 'csv'],
    fields: [
      field('title', 'Book title', 'string', true),
      field('price', 'Book price including currency', 'currency', true),
      field('availability', 'Stock availability text', 'string'),
      field('rating', 'Star rating, such as One through Five', 'string'),
      field('product_url', 'URL of the product detail page', 'url'),
    ],
    valueChecks: [
      check('title', 'book titles are not card chrome', 20, (value) => {
        const text = valueText(value);
        return text.length > 2 && !/(£|In stock|Add to basket|star-rating)/i.test(text);
      }),
      check('price', 'prices include money-like values', 20, (value) =>
        /[£$]?\s*\d/.test(valueText(value)),
      ),
      check('rating', 'ratings preserve star class/text values', 10, (value) =>
        /(one|two|three|four|five|[1-5])/i.test(valueText(value)),
      ),
    ],
  },
  {
    id: 'quotes_cards',
    label: 'Quotes cards',
    category: 'repeated-text-cards',
    seedUrl: 'https://quotes.toscrape.com/',
    description:
      'Extract quotes from the page. For each quote card, gather quote text, author, tags, and author profile URL when present.',
    minEntities: 10,
    minFieldHits: 10,
    requiredFields: ['quote_text', 'author'],
    exports: ['json', 'csv'],
    fields: [
      field('quote_text', 'The quote text', 'string', true),
      field('author', 'Quote author', 'string', true),
      field('tags', 'Tags associated with the quote', 'array'),
      field('author_url', 'URL of the author detail page', 'url'),
    ],
    valueChecks: [
      check(
        'quote_text',
        'quotes are sentence-length text',
        10,
        (value) => valueText(value).length > 20,
      ),
      check('author', 'authors are names', 10, (value) =>
        /^[\p{L}][\p{L} .'-]+$/u.test(valueText(value)),
      ),
    ],
  },
  {
    id: 'country_directory_blocks',
    label: 'Country directory blocks',
    category: 'nested-directory-blocks',
    seedUrl: 'https://www.scrapethissite.com/pages/simple/',
    description:
      'Extract country information. For each country block, gather country name, capital, population, and area in square kilometers.',
    minEntities: 200,
    minFieldHits: 100,
    requiredFields: ['country', 'capital', 'population'],
    exports: ['json'],
    fields: [
      field('country', 'Country name', 'string', true),
      field('capital', 'Capital city', 'string', true),
      field('population', 'Population value', 'number', true),
      field('area_km2', 'Area in square kilometers', 'number'),
    ],
    expectedRows: [
      rowExpectation({ country: /Zimbabwe/i, capital: /Harare/i }),
      rowExpectation({ country: /Zambia/i, capital: /Lusaka/i }),
      rowExpectation({ country: /Canada/i, capital: /Ottawa/i }),
    ],
  },
  {
    id: 'hockey_stats_table',
    label: 'Hockey stats table',
    category: 'numeric-table',
    seedUrl: 'https://www.scrapethissite.com/pages/forms/',
    description:
      'Extract hockey team season statistics from the table. For each row, gather team name, year, wins, losses, overtime losses, win percentage, goals for, and goals against.',
    minEntities: 20,
    minFieldHits: 20,
    requiredFields: ['team', 'year', 'wins', 'losses'],
    exports: ['json', 'csv'],
    fields: [
      field('team', 'Team name', 'string', true),
      field('year', 'Season year', 'number', true),
      field('wins', 'Wins', 'number', true),
      field('losses', 'Losses', 'number', true),
      field('ot_losses', 'Overtime losses', 'number'),
      field('win_pct', 'Win percentage', 'number'),
      field('goals_for', 'Goals for', 'number'),
      field('goals_against', 'Goals against', 'number'),
    ],
    valueChecks: [
      check(
        'year',
        'years look like seasons',
        20,
        (value) => Number(value) >= 1990 && Number(value) <= 2035,
      ),
      check('wins', 'wins are numeric', 20, (value) => Number.isFinite(Number(value))),
    ],
  },
  {
    id: 'book_detail_single',
    label: 'Book detail single page',
    category: 'single-product-detail',
    seedUrl: 'https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html',
    description:
      'Extract the single book product detail. Gather title, price, availability, UPC, product type, tax, and review count when present. Return one record for the product.',
    minEntities: 1,
    minFieldHits: 1,
    requiredFields: ['title', 'price', 'availability'],
    exports: ['json', 'csv'],
    fields: [
      field('title', 'Book title', 'string', true),
      field('price', 'Book price including currency', 'currency', true),
      field('availability', 'Stock availability text', 'string', true),
      field('upc', 'Product UPC', 'string'),
      field('product_type', 'Product type', 'string'),
      field('tax', 'Tax amount', 'currency'),
      field('review_count', 'Number of reviews', 'number'),
    ],
    expectedRows: [rowExpectation({ title: /A Light in the Attic/i })],
  },
  {
    id: 'quotes_author_profile',
    label: 'Quote author profile',
    category: 'profile-page',
    seedUrl: 'https://quotes.toscrape.com/author/Albert-Einstein/',
    description:
      'Extract the author profile. Gather author name, birth date, birth place, and biography text. Return one record for the author.',
    minEntities: 1,
    minFieldHits: 1,
    requiredFields: ['author', 'birth_date', 'birth_place'],
    exports: ['json'],
    fields: [
      field('author', 'Author name', 'string', true),
      field('birth_date', 'Author birth date', 'string', true),
      field('birth_place', 'Author birth place', 'string', true),
      field('biography', 'Biography or author description', 'string'),
    ],
    expectedRows: [rowExpectation({ author: /Albert Einstein/i, birth_place: /Germany/i })],
  },
  {
    id: 'hacker_news_frontpage',
    label: 'Hacker News front page',
    category: 'legacy-table-layout',
    seedUrl: 'https://news.ycombinator.com/',
    description:
      'Extract the front page story list. For each story, gather rank, title, item URL, points, submitter, and comments text when present.',
    minEntities: 10,
    minFieldHits: 10,
    requiredFields: ['title', 'item_url'],
    exports: ['json'],
    fields: [
      field('rank', 'Story rank on the page', 'number'),
      field('title', 'Story title', 'string', true),
      field('item_url', 'Story destination URL', 'url', true),
      field('points', 'Story points', 'number'),
      field('submitter', 'Submitting user', 'string'),
      field('comments', 'Comments count or comments link text', 'string'),
    ],
    valueChecks: [
      check('title', 'story titles are substantive', 10, (value) => {
        const text = valueText(value);
        return text.length > 5 && !/^(more|past|comments?|login)$/i.test(text);
      }),
    ],
  },
  {
    id: 'iana_root_zone_table',
    label: 'IANA root zone table',
    category: 'large-authoritative-table',
    seedUrl: 'https://www.iana.org/domains/root/db',
    description:
      'Extract top-level domain records from the root zone database table. For each row, gather TLD, type, sponsoring organization or manager, and record URL.',
    minEntities: 1000,
    minFieldHits: 100,
    requiredFields: ['tld', 'manager'],
    resultLimit: 500,
    exports: ['json'],
    fields: [
      field('tld', 'Top-level domain string', 'string', true),
      field('type', 'Domain type or category', 'string'),
      field('manager', 'Sponsoring organization or manager', 'string', true),
      field('record_url', 'URL for the TLD record detail page', 'url'),
    ],
    valueChecks: [
      check('tld', 'TLD values look like domain labels', 100, (value) =>
        /^\.?[a-z0-9.-]+$/i.test(valueText(value)),
      ),
    ],
  },
  {
    id: 'httpbin_html_article',
    label: 'HTTPBin simple HTML article',
    category: 'simple-document-html',
    seedUrl: 'https://httpbin.org/html',
    description:
      'Extract the simple HTML document title or heading and the main paragraph text. Return one record for the document.',
    minEntities: 1,
    minFieldHits: 1,
    requiredFields: ['heading', 'paragraph'],
    exports: ['json'],
    fields: [
      field('heading', 'Document heading or title', 'string', true),
      field('paragraph', 'Main paragraph text', 'string', true),
    ],
    valueChecks: [
      check(
        'paragraph',
        'paragraph contains article text',
        1,
        (value) => valueText(value).length > 100,
      ),
    ],
  },
  {
    id: 'httpbin_json_document',
    label: 'HTTPBin JSON document',
    category: 'json-like-document',
    seedUrl: 'https://httpbin.org/json',
    description:
      'Extract the JSON document. Gather slideshow title, author, date if available, and slide titles. Return one record for the slideshow.',
    minEntities: 1,
    minFieldHits: 1,
    requiredFields: ['slideshow_title', 'author'],
    exports: ['json'],
    fields: [
      field('slideshow_title', 'Slideshow title', 'string', true),
      field('author', 'Slideshow author', 'string', true),
      field('date', 'Slideshow date', 'string'),
      field('slide_titles', 'Titles of the slides', 'array'),
    ],
    valueChecks: [
      check('slideshow_title', 'slideshow title is extracted', 1, (value) =>
        /sample slide show/i.test(valueText(value)),
      ),
    ],
  },
  {
    id: 'discovery_book_detail',
    label: 'Discovery mode book detail',
    category: 'schema-discovery',
    seedUrl: 'https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html',
    description:
      'Discover the useful fields on the single product detail page and extract the product information without a fixed user schema.',
    schemaMode: 'discovery',
    minEntities: 1,
    schemaFieldsMin: 3,
    exports: ['json'],
    evolutionConfig: { enabled: true, batchSize: 1, maxFields: 30 },
  },
  {
    id: 'quotes_multipage_crawl',
    label: 'Quotes multi-page crawl',
    category: 'crawl-link-discovery',
    seedUrl: 'https://quotes.toscrape.com/page/1/',
    description:
      'Crawl the quote site from page one. Extract quote text, author, tags, and author profile URL across multiple crawled pages.',
    minEntities: 10,
    minFieldHits: 10,
    pagesCompletedMin: 2,
    maxDepth: 1,
    maxPages: 4,
    requiredFields: ['quote_text', 'author'],
    exports: ['json'],
    fields: [
      field('quote_text', 'The quote text', 'string', true),
      field('author', 'Quote author', 'string', true),
      field('tags', 'Tags associated with the quote', 'array'),
      field('author_url', 'URL of the author detail page', 'url'),
    ],
  },
  {
    id: 'robots_blocked_webscraper',
    label: 'Robots-blocked product URL',
    category: 'robots-and-skip-handling',
    seedUrl: 'https://webscraper.io/test-sites/e-commerce/allinone/computers/laptops',
    description:
      'Attempt a product-card extraction on a URL that currently blocks automated scraping. The expected behavior is a clean terminal job with skipped or failed page accounting, not a stuck job.',
    minEntities: 0,
    expectedSkip: true,
    pagesSkippedMin: 1,
    expectedTerminalStatuses: ['completed', 'failed'],
    allowNoUsage: true,
    exports: [],
    fields: [
      field('product_name', 'Laptop product name', 'string', true),
      field('price', 'Product price', 'currency', true),
      field('description', 'Product description', 'string'),
      field('review_count', 'Number of reviews', 'number'),
      field('rating', 'Rating value or star count', 'string'),
    ],
  },
];

const PROFILE_CASES = {
  workflows: [],
  smoke: ['books_product_cards', 'quotes_cards', 'country_directory_blocks', 'hockey_stats_table'],
  broad: [
    'books_product_cards',
    'quotes_cards',
    'country_directory_blocks',
    'hockey_stats_table',
    'book_detail_single',
    'quotes_author_profile',
    'hacker_news_frontpage',
    'iana_root_zone_table',
    'httpbin_html_article',
    'discovery_book_detail',
    'robots_blocked_webscraper',
  ],
  stress: [
    'books_product_cards',
    'quotes_cards',
    'country_directory_blocks',
    'hockey_stats_table',
    'book_detail_single',
    'quotes_author_profile',
    'hacker_news_frontpage',
    'iana_root_zone_table',
    'httpbin_html_article',
    'httpbin_json_document',
    'discovery_book_detail',
    'quotes_multipage_crawl',
    'robots_blocked_webscraper',
  ],
};
PROFILE_CASES.all = CASES.map((testCase) => testCase.id);

if (args.has('--help') || args.has('-h')) {
  printHelp();
  process.exit(0);
}

if (args.has('--list')) {
  printCaseList();
  process.exit(0);
}

if (process.env.SPATULA_LIVE_LLM !== '1') {
  console.error(
    'Refusing to run: set SPATULA_LIVE_LLM=1 to confirm this live matrix can crawl external sites and incur LLM cost.',
  );
  console.error('Example: SPATULA_LIVE_LLM=1 SP_LIVE_PROFILE=smoke pnpm live:matrix');
  process.exit(2);
}

function numberEnv(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function field(name, description, type, required = false) {
  return { name, description, type, required };
}

function check(fieldName, label, minMatches, ok) {
  return { fieldName, label, minMatches, ok };
}

function rowExpectation(fields) {
  return { fields };
}

function selectedCases() {
  const profileIds = PROFILE_CASES[PROFILE];
  if (!profileIds) {
    throw new Error(
      `Unknown SP_LIVE_PROFILE=${PROFILE}. Valid profiles: ${Object.keys(PROFILE_CASES).join(', ')}`,
    );
  }
  const include = csvSet(process.env.SP_LIVE_CASES);
  const skip = csvSet(process.env.SP_LIVE_SKIP_CASES);
  const baseIds = include.size > 0 ? include : new Set(profileIds);
  return CASES.filter((testCase) => baseIds.has(testCase.id) && !skip.has(testCase.id));
}

function csvSet(value) {
  return new Set(
    (value ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  );
}

function printHelp() {
  console.log(`Spatula live platform matrix

Usage:
  SPATULA_LIVE_LLM=1 pnpm live:matrix
  SPATULA_LIVE_LLM=1 SP_LIVE_PROFILE=smoke pnpm live:matrix
  SPATULA_LIVE_LLM=1 SP_LIVE_CASES=books_product_cards,quotes_cards pnpm live:matrix

Environment:
  SPATULA_API_URL           API base URL. Default: http://127.0.0.1:3100
  SP_LIVE_MODEL            LLM model. Default: deepseek/deepseek-v4-flash
  SP_LIVE_PROFILE          workflows | smoke | broad | stress | all. Default: broad
  SP_LIVE_CASES            Comma-separated explicit case IDs
  SP_LIVE_SKIP_CASES       Comma-separated case IDs to skip
  SP_LIVE_REPORT_PATH      Optional JSON report path
  SP_LIVE_CRAWLER          playwright | firecrawl. Default: firecrawl
  SP_LIVE_DISABLE_LOCAL_WEBHOOK=1 disables local webhook receiver

Commands:
  --list                   Print available cases
  --help                   Print this help
`);
}

function printCaseList() {
  console.log(`profiles=${Object.keys(PROFILE_CASES).join(', ')}`);
  for (const testCase of CASES) {
    console.log(`${testCase.id}\t${testCase.category}\t${testCase.seedUrl}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(path, opts = {}, attempt = 0) {
  const url = `${API_URL}${path}`;
  const headers = {
    accept: opts.accept ?? 'application/json',
    ...(opts.headers ?? {}),
  };
  if (opts.tenantId) headers['x-tenant-id'] = opts.tenantId;
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
  if (opts.body !== undefined && !headers['content-type'] && !headers['Content-Type']) {
    headers['content-type'] = 'application/json';
  }

  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: opts.signal,
  });
  const contentType = res.headers.get('content-type') ?? '';
  const text = await res.text();
  const body = parseBody(text, contentType);
  const okStatuses = new Set(opts.okStatuses ?? []);
  const allowed = res.ok || okStatuses.has(res.status);

  if (!allowed && res.status === 429 && attempt < 8) {
    const resetAt = body?.error?.details?.resetAt;
    const waitMs =
      typeof resetAt === 'number' ? Math.max(1_000, resetAt * 1_000 - Date.now() + 1_000) : 61_000;
    console.log(
      `[rate-limit] ${opts.method ?? 'GET'} ${path} waiting ${Math.ceil(waitMs / 1_000)}s`,
    );
    await sleep(waitMs);
    return request(path, opts, attempt + 1);
  }

  if (!allowed) {
    const detail = typeof body === 'string' ? body.slice(0, 700) : JSON.stringify(body);
    throw new Error(`${opts.method ?? 'GET'} ${path} -> ${res.status}: ${detail}`);
  }

  return { status: res.status, headers: res.headers, body, text };
}

function parseBody(text, contentType) {
  if (!text) return null;
  if (contentType.includes('application/json') || /^[\s\n\r]*[{[]/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

async function api(path, opts = {}) {
  return (await request(path, opts)).body;
}

async function pollJob(jobId, tenantId, id) {
  const deadline = Date.now() + MAX_WAIT_MS;
  let last = '';
  while (Date.now() < deadline) {
    const job = await api(`/api/v1/jobs/${jobId}`, { tenantId });
    const data = job.data;
    const stats = data.stats ?? {};
    const line = `${data.status} completed=${stats.pagesCompleted ?? 0} skipped=${stats.pagesSkipped ?? 0} failed=${
      stats.pagesFailed ?? 0
    } pending=${stats.pagesPending ?? 0} inProgress=${stats.pagesInProgress ?? 0}`;
    if (line !== last) {
      console.log(`[${id}] job ${line}`);
      last = line;
    }
    if (['completed', 'failed', 'cancelled'].includes(data.status)) return data;
    await sleep(POLL_MS);
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}

async function pollExport(jobId, exportId, tenantId, id) {
  const deadline = Date.now() + EXPORT_WAIT_MS;
  let last = '';
  while (Date.now() < deadline) {
    const exp = await api(`/api/v1/jobs/${jobId}/export/${exportId}`, { tenantId });
    const status = exp.data.status;
    if (status !== last) {
      console.log(`[${id}] export ${exportId} ${status}`);
      last = status;
    }
    if (['completed', 'failed'].includes(status)) return exp.data;
    await sleep(3_000);
  }
  throw new Error(`Timed out waiting for export ${exportId}`);
}

function recordData(row) {
  return row?.data ?? row?.mergedData ?? row?.entity?.mergedData ?? row ?? {};
}

function valueText(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(valueText).filter(Boolean).join(' ');
  if (typeof value === 'object')
    return Object.values(value).map(valueText).filter(Boolean).join(' ');
  return String(value).trim();
}

function isMeaningfulValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.some(isMeaningfulValue);
  if (typeof value === 'object') return Object.values(value).some(isMeaningfulValue);
  return true;
}

function isMeaningfulRow(row) {
  return isMeaningfulValue(recordData(row));
}

function fieldHits(rows, fields) {
  const hits = Object.fromEntries(fields.map((fieldName) => [fieldName, 0]));
  for (const row of rows) {
    const data = recordData(row);
    for (const fieldName of fields) {
      if (isMeaningfulValue(data[fieldName])) hits[fieldName]++;
    }
  }
  return hits;
}

function assertValueChecks(rows, checks, failures) {
  for (const test of checks ?? []) {
    let matches = 0;
    const bad = [];
    for (const row of rows) {
      const value = recordData(row)[test.fieldName];
      if (!isMeaningfulValue(value)) continue;
      if (test.ok(value, recordData(row))) {
        matches += 1;
      } else if (bad.length < 3) {
        bad.push(valueText(value));
      }
    }
    if (matches < test.minMatches) {
      failures.push(
        `${test.label}: ${matches} matches < ${test.minMatches}; bad samples=${JSON.stringify(bad)}`,
      );
    }
  }
}

function assertExpectedRows(rows, expectedRows, failures) {
  for (const expected of expectedRows ?? []) {
    const matched = rows.some((row) => {
      const data = recordData(row);
      return Object.entries(expected.fields).every(([fieldName, pattern]) => {
        const text = valueText(data[fieldName]);
        return pattern.test(text);
      });
    });
    if (!matched) {
      const rendered = Object.entries(expected.fields)
        .map(([fieldName, pattern]) => `${fieldName}~${pattern}`)
        .join(', ');
      failures.push(`missing expected row: ${rendered}`);
    }
  }
}

async function createTenant() {
  const headers = {};
  if (process.env.TENANT_CREATION_SECRET) {
    headers['x-tenant-creation-secret'] = process.env.TENANT_CREATION_SECRET;
  }
  const tenant = await api('/api/v1/tenants', {
    method: 'POST',
    headers,
    body: { name: `live-matrix-${new Date().toISOString()}-${randomUUID().slice(0, 8)}` },
  });
  return tenant.data.id;
}

function buildJobBody(testCase, webhookConfig) {
  const schemaMode = testCase.schemaMode ?? 'fixed';
  const schema = {
    mode: schemaMode,
    evolutionConfig: testCase.evolutionConfig ?? { enabled: false, batchSize: 10, maxFields: 30 },
  };
  if (testCase.fields) schema.userFields = testCase.fields;

  const body = {
    name: `Live matrix - ${testCase.label}`,
    description: testCase.description,
    seedUrls: [testCase.seedUrl],
    crawl: {
      maxDepth: testCase.maxDepth ?? 0,
      maxPages: testCase.maxPages ?? 1,
      concurrency: testCase.concurrency ?? 1,
      crawlerType: testCase.crawlerType ?? CRAWLER,
    },
    schema,
    llm: {
      primaryModel: MODEL,
      modelOverrides: testCase.modelOverrides ?? {},
    },
    reconciliation: {
      matchStrategy: testCase.matchStrategy ?? 'composite_key',
      conflictResolution: testCase.conflictResolution ?? 'most_complete',
      enableLLMMatching: testCase.enableLLMMatching ?? false,
      fuzzyMatchThreshold: 0.85,
    },
  };
  if (webhookConfig) body.webhooks = webhookConfig;
  return body;
}

async function startJob(jobId, tenantId, mode) {
  if (mode === 'patch') {
    await api(`/api/v1/jobs/${jobId}`, {
      method: 'PATCH',
      tenantId,
      body: { action: 'start' },
      idempotencyKey: `live-start-${jobId}`,
    });
    return;
  }
  await api(`/api/v1/jobs/${jobId}/start`, { method: 'POST', tenantId });
}

async function runCase(testCase, tenantId) {
  const startedAt = Date.now();
  const webhook = testCase.webhook ? await maybeCreateWebhookReceiver(testCase.id) : null;
  const webhookConfig = webhook
    ? {
        url: webhook.url,
        secret: webhook.secret,
        events: [
          'job.completed',
          'job.failed',
          'job.cancelled',
          'export.completed',
          'action.pending',
        ],
      }
    : undefined;

  const created = await api('/api/v1/jobs', {
    method: 'POST',
    tenantId,
    body: buildJobBody(testCase, webhookConfig),
    idempotencyKey: `live-create-${testCase.id}-${randomUUID()}`,
  });
  const jobId = created.data.id;
  console.log(`[${testCase.id}] created ${jobId}`);

  const sse = testCase.sse ? await openSseCollector(jobId, tenantId) : null;

  await startJob(jobId, tenantId, testCase.startMode);
  const job = await pollJob(jobId, tenantId, testCase.id);

  const result = await collectCaseResult(testCase, tenantId, jobId, job, sse, webhook);
  result.durationMs = Date.now() - startedAt;

  if (webhook) await webhook.close();
  if (sse) await sse.close();
  return result;
}

async function collectCaseResult(testCase, tenantId, jobId, job, sse, webhook) {
  const terminalStatuses = testCase.expectedTerminalStatuses ?? ['completed'];
  const failures = [];
  if (!terminalStatuses.includes(job.status)) failures.push(`job status ${job.status}`);
  if ((job.stats?.pagesPending ?? 0) !== 0)
    failures.push(`pagesPending=${job.stats?.pagesPending}`);
  if ((job.stats?.pagesInProgress ?? 0) !== 0)
    failures.push(`pagesInProgress=${job.stats?.pagesInProgress}`);
  if (
    (job.stats?.pagesCompleted ?? 0) <
    (testCase.pagesCompletedMin ?? (testCase.expectedSkip ? 0 : 1))
  ) {
    failures.push(`pagesCompleted=${job.stats?.pagesCompleted ?? 0}`);
  }
  if ((job.stats?.pagesSkipped ?? 0) < (testCase.pagesSkippedMin ?? 0)) {
    failures.push(`pagesSkipped=${job.stats?.pagesSkipped ?? 0} < ${testCase.pagesSkippedMin}`);
  }

  if (testCase.expectedSkip) {
    const usage = await api('/api/v1/usage?period=1d', { tenantId });
    const usageByJob = usage.data?.byJob?.find((entry) => entry.jobId === jobId) ?? null;
    return {
      id: testCase.id,
      label: testCase.label,
      category: testCase.category,
      seedUrl: testCase.seedUrl,
      jobId,
      status: failures.length === 0 ? 'passed' : 'failed',
      failures,
      jobStatus: job.status,
      stats: job.stats,
      usage: usageByJob,
      expectedSkip: true,
    };
  }

  const limit = testCase.resultLimit ?? 500;
  const [
    schema,
    schemaVersions,
    schemaV1,
    extractions,
    entities,
    entitySources,
    actions,
    docs,
    quality,
    usage,
  ] = await Promise.all([
    api(`/api/v1/jobs/${jobId}/schema`, { tenantId }),
    api(`/api/v1/jobs/${jobId}/schema/versions`, { tenantId }),
    api(`/api/v1/jobs/${jobId}/schema/versions/1`, { tenantId }),
    api(`/api/v1/jobs/${jobId}/extractions?limit=${limit}`, { tenantId }),
    api(`/api/v1/jobs/${jobId}/entities?limit=${limit}`, { tenantId }),
    api(`/api/v1/jobs/${jobId}/entity-sources?limit=${limit}`, { tenantId }),
    api(`/api/v1/jobs/${jobId}/actions?limit=${limit}`, { tenantId }),
    api(`/api/v1/jobs/${jobId}/documentation`, { tenantId }),
    api(`/api/v1/jobs/${jobId}/quality`, { tenantId }),
    api('/api/v1/usage?period=1d', { tenantId }),
  ]);

  const extractionRows = extractions.data ?? [];
  const entityRows = entities.data ?? [];
  const extractionTotal = extractions.pagination?.total ?? extractionRows.length;
  const entityTotal = entities.pagination?.total ?? entityRows.length;
  const sourceTotal = entitySources.pagination?.total ?? entitySources.data?.length ?? 0;
  const usageByJob = usage.data?.byJob?.find((entry) => entry.jobId === jobId) ?? null;
  const requiredFields = testCase.requiredFields ?? [];
  const extractionHits = fieldHits(extractionRows, requiredFields);
  const entityHits = fieldHits(entityRows, requiredFields);
  const minFieldHits = testCase.minFieldHits ?? testCase.minEntities ?? 1;
  const emptyExtractions = extractionRows.filter((row) => !isMeaningfulRow(row)).length;
  const emptyEntities = entityRows.filter((row) => !isMeaningfulRow(row)).length;
  const schemaFields = schema.data?.definition?.fields?.map((item) => item.name) ?? [];

  if (extractionTotal < testCase.minEntities)
    failures.push(`extractions total ${extractionTotal} < ${testCase.minEntities}`);
  if (entityTotal < testCase.minEntities)
    failures.push(`entities total ${entityTotal} < ${testCase.minEntities}`);
  if (emptyExtractions > 0)
    failures.push(`${emptyExtractions} empty extractions in fetched sample`);
  if (emptyEntities > 0) failures.push(`${emptyEntities} empty entities in fetched sample`);
  if (sourceTotal < Math.min(entityTotal, limit))
    failures.push(
      `entity sources total ${sourceTotal} < expected sample ${Math.min(entityTotal, limit)}`,
    );
  if (schemaVersions.data?.length < 1) failures.push('schema versions missing');
  if (!schemaV1.data?.definition) failures.push('schema version 1 missing definition');
  if ((testCase.schemaFieldsMin ?? 0) > schemaFields.length) {
    failures.push(`schema fields ${schemaFields.length} < ${testCase.schemaFieldsMin}`);
  }
  for (const fieldName of requiredFields) {
    if ((extractionHits[fieldName] ?? 0) < Math.min(minFieldHits, extractionRows.length)) {
      failures.push(
        `extraction field ${fieldName} hits ${extractionHits[fieldName] ?? 0} < ${Math.min(minFieldHits, extractionRows.length)}`,
      );
    }
    if ((entityHits[fieldName] ?? 0) < Math.min(minFieldHits, entityRows.length)) {
      failures.push(
        `entity field ${fieldName} hits ${entityHits[fieldName] ?? 0} < ${Math.min(minFieldHits, entityRows.length)}`,
      );
    }
  }
  if (!testCase.allowNoUsage && (!usageByJob || usageByJob.tokens <= 0))
    failures.push('no LLM usage recorded for job');
  if (quality.data?.entityCount !== entityTotal)
    failures.push(
      `quality entityCount ${quality.data?.entityCount} != entity total ${entityTotal}`,
    );
  if (docs.data?.entityCount !== entityTotal)
    failures.push(
      `documentation entityCount ${docs.data?.entityCount} != entity total ${entityTotal}`,
    );

  assertValueChecks(entityRows, testCase.valueChecks, failures);
  assertExpectedRows(entityRows, testCase.expectedRows, failures);

  const pagination = await verifyPagination(jobId, tenantId, entityRows);
  failures.push(...pagination.failures);

  const entityDetail = await verifyEntityDetail(jobId, tenantId, entityRows, failures);
  const actionReview = await maybeReviewActions(jobId, tenantId, actions);
  const exports = await runExports(testCase, jobId, tenantId, entityTotal, failures);

  const sseSummary = sse ? await summarizeSse(sse, failures) : null;
  const webhookSummary = webhook ? await summarizeWebhook(webhook, testCase, failures) : null;

  return {
    id: testCase.id,
    label: testCase.label,
    category: testCase.category,
    seedUrl: testCase.seedUrl,
    jobId,
    status: failures.length === 0 ? 'passed' : 'failed',
    failures,
    jobStatus: job.status,
    stats: job.stats,
    schemaFields,
    schemaVersionCount: schemaVersions.data?.length ?? 0,
    extractionCount: extractionTotal,
    entityCount: entityTotal,
    entitySourceCount: sourceTotal,
    actionCount: actions.pagination?.total ?? actions.data?.length ?? 0,
    actionReview,
    quality: quality.data,
    documentation: {
      entityCount: docs.data?.entityCount,
      fieldCount: docs.data?.fields?.length ?? docs.data?.schema?.fields?.length ?? null,
    },
    usage: usageByJob,
    extractionHits,
    entityHits,
    pagination,
    entityDetail,
    exports,
    sse: sseSummary,
    webhook: webhookSummary,
    sampleExtractions: extractionRows.slice(0, 3).map(recordData),
    sampleEntities: entityRows.slice(0, 3).map(recordData),
  };
}

async function verifyPagination(jobId, tenantId, rows) {
  const failures = [];
  if (rows.length < 3) return { checked: false, failures };
  const since = encodeURIComponent('1970-01-01T00:00:00.000Z');
  const page1 = await api(`/api/v1/jobs/${jobId}/entities?limit=2&since=${since}`, { tenantId });
  if (!page1.pagination?.nextCursor)
    return { checked: true, failures: ['entity cursor pagination missing nextCursor'] };
  const cursor = encodeURIComponent(page1.pagination.nextCursor);
  const page2 = await api(`/api/v1/jobs/${jobId}/entities?limit=2&cursor=${cursor}`, { tenantId });
  const firstIds = new Set((page1.data ?? []).map((row) => row.id));
  const duplicate = (page2.data ?? []).find((row) => firstIds.has(row.id));
  if (duplicate) failures.push(`entity cursor pagination duplicated id ${duplicate.id}`);
  return {
    checked: true,
    failures,
    firstPage: page1.data?.length ?? 0,
    secondPage: page2.data?.length ?? 0,
    hasMore: page1.pagination?.hasMore ?? false,
  };
}

async function verifyEntityDetail(jobId, tenantId, rows, failures) {
  const first = rows[0];
  if (!first?.id) return { checked: false };
  const detail = await api(`/api/v1/jobs/${jobId}/entities/${first.id}`, { tenantId });
  if (!detail.data?.id) failures.push('entity detail missing id');
  if (!Array.isArray(detail.data?.sources)) failures.push('entity detail missing sources array');
  return {
    checked: true,
    id: detail.data?.id,
    sources: detail.data?.sources?.length ?? 0,
  };
}

async function maybeReviewActions(jobId, tenantId, actions) {
  const pending = (actions.data ?? []).filter((action) => action.status === 'pending_review');
  if (pending.length === 0) return { checked: true, pending: 0, approved: 0 };
  const approved = await api(`/api/v1/jobs/${jobId}/actions/approve-all`, {
    method: 'POST',
    tenantId,
    body: { reviewedBy: 'live-platform-matrix' },
  });
  return { checked: true, pending: pending.length, approved: approved.data?.length ?? 0 };
}

async function runExports(testCase, jobId, tenantId, entityTotal, failures) {
  const results = [];
  for (const format of testCase.exports ?? ['json']) {
    const body = {
      format,
      includeProvenance: format === 'json',
      ...(testCase.requiredFields?.length ? { fields: testCase.requiredFields.slice(0, 4) } : {}),
    };
    const created = await api(`/api/v1/jobs/${jobId}/export`, { method: 'POST', tenantId, body });
    const exportId = created.data.id;
    const record = await pollExport(jobId, exportId, tenantId, testCase.id);
    if (record.status !== 'completed') failures.push(`${format} export status ${record.status}`);
    let download = null;
    if (record.status === 'completed') {
      const response = await request(`/api/v1/jobs/${jobId}/export/${exportId}/download`, {
        tenantId,
        accept: format === 'json' ? 'application/json' : 'text/csv,application/octet-stream',
      });
      download = summarizeDownload(format, response.body, response.text, entityTotal, failures);
    }
    const list = await api(`/api/v1/jobs/${jobId}/exports?limit=10`, { tenantId });
    results.push({
      id: exportId,
      format,
      status: record.status,
      fileSize: record.fileSize ?? null,
      download,
      exportsListed: list.data?.length ?? 0,
    });
  }
  return results;
}

function summarizeDownload(format, body, text, entityTotal, failures) {
  if (format === 'json') {
    const entities = Array.isArray(body?.entities) ? body.entities : [];
    if (entities.length !== entityTotal) {
      failures.push(
        `json export entity count ${entities.length} != API entity total ${entityTotal}`,
      );
    }
    return {
      entityCount: entities.length,
      metadata: body?.metadata ?? null,
      sample: entities.slice(0, 2),
    };
  }
  if (format === 'csv') {
    const csv = typeof body === 'string' ? body : text;
    const lines = csv.split(/\r?\n/).filter((line) => line.trim() !== '');
    if (lines.length < 2) failures.push(`csv export has ${lines.length} non-empty lines`);
    return { lineCount: lines.length, header: lines[0] ?? '' };
  }
  return { bytes: text.length };
}

async function openSseCollector(jobId, tenantId) {
  const tokenResponse = await api('/api/v1/ws-token', { method: 'POST', tenantId });
  const token = encodeURIComponent(tokenResponse.data.token);
  const events = [];
  const controller = new AbortController();
  const opened = { value: false };
  const done = (async () => {
    try {
      const response = await fetch(`${API_URL}/api/v1/jobs/${jobId}/events?token=${token}`, {
        headers: { accept: 'text/event-stream' },
        signal: controller.signal,
      });
      opened.value = true;
      if (!response.ok) {
        events.push({ type: 'sse_error', status: response.status });
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const event = parseSsePart(part);
          if (event) events.push(event);
        }
      }
    } catch (error) {
      if (error?.name !== 'AbortError')
        events.push({ type: 'sse_exception', message: error.message });
    }
  })();
  await sleep(250);
  return {
    events,
    opened,
    async close() {
      controller.abort();
      await done.catch(() => undefined);
    },
  };
}

function parseSsePart(part) {
  let type = 'message';
  const dataLines = [];
  for (const line of part.split(/\r?\n/)) {
    if (line.startsWith('event:')) type = line.slice(6).trim();
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join('\n');
  try {
    return { type, data: JSON.parse(raw) };
  } catch {
    return { type, data: raw };
  }
}

async function summarizeSse(sse, failures) {
  await sleep(1_000);
  await sse.close();
  const frameTypes = [...new Set(sse.events.map((event) => event.type))];
  const eventTypes = [...new Set(sse.events.map((event) => event.data?.type ?? event.type))];
  if (sse.events.length === 0) failures.push('SSE received no events');
  if (
    !eventTypes.some((type) =>
      ['job_status_changed', 'task_completed', 'entity_created'].includes(type),
    )
  ) {
    failures.push(`SSE missing job/task/entity event; saw ${eventTypes.join(',') || 'none'}`);
  }
  return {
    opened: sse.opened.value,
    count: sse.events.length,
    frameTypes,
    eventTypes,
    sample: sse.events.slice(0, 5),
  };
}

async function maybeCreateWebhookReceiver(caseId) {
  if (LOCAL_WEBHOOK_DISABLED || !isLocalApiUrl(API_URL)) {
    return null;
  }
  const secret = `live-matrix-${caseId}-${randomUUID()}`;
  const received = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const signature = req.headers['x-spatula-signature'];
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
    received.push({
      method: req.method,
      url: req.url,
      raw,
      body,
      signature,
      signatureValid: verifyWebhookSignature(raw, secret, signature),
      userAgent: req.headers['user-agent'],
    });
    res.writeHead(204);
    res.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    secret,
    received,
    url: `http://127.0.0.1:${address.port}/spatula-live-matrix-webhook`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function isLocalApiUrl(url) {
  try {
    const host = new URL(url).hostname;
    return ['localhost', '127.0.0.1', '::1'].includes(host);
  } catch {
    return false;
  }
}

function verifyWebhookSignature(raw, secret, signature) {
  if (typeof signature !== 'string' || !signature.startsWith('sha256=')) return false;
  const actual = Buffer.from(signature.slice('sha256='.length), 'hex');
  const expected = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'), 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function summarizeWebhook(webhook, testCase, failures) {
  await waitFor(() => webhook.received.length >= 1, 20_000);
  const eventTypes = webhook.received.map((request) => request.body?.type).filter(Boolean);
  const invalid = webhook.received.filter((request) => !request.signatureValid);
  if (!eventTypes.includes('job.completed') && !eventTypes.includes('job.failed')) {
    failures.push(`webhook missing terminal job event; saw ${eventTypes.join(',') || 'none'}`);
  }
  if (testCase.exports?.length && !eventTypes.includes('export.completed')) {
    failures.push(`webhook missing export.completed; saw ${eventTypes.join(',') || 'none'}`);
  }
  if (invalid.length > 0) failures.push(`${invalid.length} webhook signatures invalid`);
  return {
    received: webhook.received.length,
    eventTypes,
    signaturesValid: invalid.length === 0,
    url: webhook.url,
  };
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(500);
  }
  return predicate();
}

async function runPreflight(tenantId) {
  const checks = [];
  await timedCheck(checks, 'health-live', () => api('/health/live'));
  await timedCheck(checks, 'health-ready', () => api('/health/ready'));
  await timedCheck(checks, 'version-probe', () => api('/.well-known/spatula-version'));
  await timedCheck(checks, 'openapi', async () => {
    const openapi = await api('/api/openapi.json');
    if (!openapi.openapi || !openapi.paths)
      throw new Error('OpenAPI document missing required keys');
    const paths = Object.keys(openapi.paths);
    for (const expected of ['/api/v1/jobs', '/api/v1/jobs/{id}', '/api/v1/jobs/{jobId}/entities']) {
      if (!paths.includes(expected)) throw new Error(`OpenAPI missing ${expected}`);
    }
    return { pathCount: paths.length };
  });
  await timedCheck(checks, 'auth-me', () => api('/api/v1/auth/me', { tenantId }));
  return checks;
}

async function runApiKeyWorkflow(tenantId) {
  const checks = [];
  let keyId = null;
  let rotatedId = null;
  await timedCheck(checks, 'api-key-create-list-rotate-revoke', async () => {
    const created = await api('/api/v1/api-keys', {
      method: 'POST',
      tenantId,
      body: { name: `live-matrix-${Date.now()}`, scopes: ['jobs:read', 'jobs:write'] },
    });
    keyId = created.data.id;
    if (!created.data.key?.startsWith('sk_live_'))
      throw new Error('created API key missing sk_live_ prefix');
    const listed = await api('/api/v1/api-keys', { tenantId });
    if (!(listed.data ?? []).some((item) => item.id === keyId))
      throw new Error('created API key absent from list');
    const rotated = await api(`/api/v1/api-keys/${keyId}/rotate`, {
      method: 'POST',
      tenantId,
      body: { gracePeriodSeconds: 60 },
    });
    rotatedId = rotated.data.id;
    if (!rotated.data.key?.startsWith('sk_live_'))
      throw new Error('rotated API key missing sk_live_ prefix');
    await request(`/api/v1/api-keys/${keyId}`, {
      method: 'DELETE',
      tenantId,
      okStatuses: [200, 204],
    });
    await request(`/api/v1/api-keys/${rotatedId}`, {
      method: 'DELETE',
      tenantId,
      okStatuses: [200, 204],
    });
    return { keyId, rotatedId };
  });
  return checks;
}

async function runIdempotencyWorkflow(tenantId) {
  const checks = [];
  await timedCheck(checks, 'job-create-idempotency', async () => {
    const key = `live-idempotency-${randomUUID()}`;
    const body = buildJobBody({
      id: 'idempotency_probe',
      label: 'Idempotency probe',
      seedUrl: 'https://quotes.toscrape.com/',
      description: 'Pending job created only to verify idempotent job creation.',
      fields: [field('quote_text', 'Quote text', 'string', true)],
    });
    const first = await api('/api/v1/jobs', {
      method: 'POST',
      tenantId,
      body,
      idempotencyKey: key,
    });
    const second = await api('/api/v1/jobs', {
      method: 'POST',
      tenantId,
      body,
      idempotencyKey: key,
    });
    if (first.data.id !== second.data.id)
      throw new Error(`idempotent create returned ${first.data.id} then ${second.data.id}`);
    await api('/api/v1/jobs/batch', {
      method: 'POST',
      tenantId,
      body: { action: 'delete', ids: [first.data.id] },
    });
    return { jobId: first.data.id };
  });
  return checks;
}

async function runBatchWorkflow(tenantId) {
  const checks = [];
  await timedCheck(checks, 'jobs-batch-delete', async () => {
    const ids = [];
    for (let i = 0; i < 2; i += 1) {
      const created = await api('/api/v1/jobs', {
        method: 'POST',
        tenantId,
        body: buildJobBody({
          id: `batch_probe_${i}`,
          label: `Batch probe ${i}`,
          seedUrl: 'https://quotes.toscrape.com/',
          description: 'Pending job created only to verify batch operations.',
          fields: [field('quote_text', 'Quote text', 'string', true)],
        }),
      });
      ids.push(created.data.id);
    }
    const deleted = await api('/api/v1/jobs/batch', {
      method: 'POST',
      tenantId,
      body: { action: 'delete', ids },
    });
    if ((deleted.data?.succeeded?.length ?? 0) !== ids.length) {
      throw new Error(
        `batch delete succeeded ${deleted.data?.succeeded?.length ?? 0}/${ids.length}`,
      );
    }
    return { ids };
  });
  return checks;
}

async function runAdminWorkflow(tenantId) {
  const checks = [];
  for (const [name, path] of [
    ['admin-system-health', '/api/v1/admin/system/health'],
    ['admin-system-metrics', '/api/v1/admin/system/metrics'],
    ['admin-workers', '/api/v1/admin/workers'],
    ['admin-jobs', `/api/v1/admin/jobs?tenantId=${tenantId}&limit=5`],
  ]) {
    await timedCheck(checks, name, async () => {
      const response = await request(path, { tenantId, okStatuses: [403] });
      if (response.status === 403) return { skipped: true, reason: 'admin scope unavailable' };
      if (!response.body?.data) throw new Error('admin response missing data');
      return {
        keys: Object.keys(response.body.data).slice(0, 8),
        count: Array.isArray(response.body.data) ? response.body.data.length : undefined,
      };
    });
  }
  return checks;
}

async function timedCheck(checks, name, fn) {
  const startedAt = Date.now();
  try {
    const data = await fn();
    const status = data?.skipped ? 'skipped' : 'passed';
    console.log(`[workflow] ${status} ${name}`);
    checks.push({ name, status, durationMs: Date.now() - startedAt, data });
  } catch (error) {
    console.log(`[workflow] failed ${name}: ${error.message}`);
    checks.push({
      name,
      status: 'failed',
      durationMs: Date.now() - startedAt,
      error: error.message,
    });
  }
}

async function main() {
  const cases = selectedCases();
  console.log(
    `LIVE_PLATFORM_MATRIX api=${API_URL} profile=${PROFILE} model=${MODEL} crawler=${CRAWLER} cases=${cases.length}`,
  );

  const tenantId = await createTenant();
  console.log(`LIVE_PLATFORM_MATRIX_TENANT ${tenantId}`);

  const workflows = [];
  workflows.push(...(await runPreflight(tenantId)));
  workflows.push(...(await runApiKeyWorkflow(tenantId)));
  workflows.push(...(await runIdempotencyWorkflow(tenantId)));
  workflows.push(...(await runBatchWorkflow(tenantId)));

  const results = [];
  for (const testCase of cases) {
    console.log(`LIVE_PLATFORM_MATRIX_CASE_START ${testCase.id} ${testCase.seedUrl}`);
    try {
      const result = await runCase(testCase, tenantId);
      results.push(result);
      console.log(`LIVE_PLATFORM_MATRIX_CASE_${result.status.toUpperCase()} ${testCase.id}`);
    } catch (error) {
      results.push({
        id: testCase.id,
        label: testCase.label,
        category: testCase.category,
        seedUrl: testCase.seedUrl,
        status: 'failed',
        failures: [error instanceof Error ? error.message : String(error)],
      });
      console.log(`LIVE_PLATFORM_MATRIX_CASE_FAILED ${testCase.id}`);
      console.error(error instanceof Error ? error.stack : error);
    }
  }

  workflows.push(...(await runAdminWorkflow(tenantId)));

  const summary = {
    generatedAt: new Date().toISOString(),
    apiUrl: API_URL,
    profile: PROFILE,
    model: MODEL,
    crawler: CRAWLER,
    tenantId,
    passed: results.filter((result) => result.status === 'passed').length,
    failed: results.filter((result) => result.status === 'failed').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    workflowPassed: workflows.filter((result) => result.status === 'passed').length,
    workflowFailed: workflows.filter((result) => result.status === 'failed').length,
    workflowSkipped: workflows.filter((result) => result.status === 'skipped').length,
    workflows,
    results,
  };

  if (REPORT_PATH) {
    const path = resolve(REPORT_PATH);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`LIVE_PLATFORM_MATRIX_REPORT_WRITTEN ${path}`);
  }

  console.log('LIVE_PLATFORM_MATRIX_REPORT_START');
  console.log(JSON.stringify(summary, null, 2));
  console.log('LIVE_PLATFORM_MATRIX_REPORT_END');

  if (summary.failed > 0 || summary.workflowFailed > 0) {
    console.error(
      `LIVE_PLATFORM_MATRIX_FAILED cases=${summary.passed}/${results.length} workflows=${summary.workflowPassed}/${workflows.length}`,
    );
    process.exit(1);
  }
  console.log(
    `LIVE_PLATFORM_MATRIX_PASSED cases=${summary.passed}/${results.length} workflows=${summary.workflowPassed}/${workflows.length}`,
  );
}

main().catch((error) => {
  console.error('LIVE_PLATFORM_MATRIX_FATAL:', error instanceof Error ? error.stack : error);
  process.exit(1);
});
