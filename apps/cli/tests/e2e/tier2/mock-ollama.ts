import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface MockOllamaConfig {
  mode: 'happy' | 'malformed-json' | 'timeout' | 'zod-failure';
  failOnComponent?: string;
  failOnNthCall?: number;
  timeoutDelayMs?: number;
  /** When true, extractor always returns _unmapped: [] (tests zero-unmapped-fields path) */
  emptyUnmapped?: boolean;
}

export interface MockOllamaRequest {
  timestamp: number;
  model: string;
  component: string;
  systemPromptPreview: string;
  userPromptPreview: string;
  fullSystemPrompt: string;
  fullUserPrompt: string;
}

export interface MockOllamaServer {
  port: number;
  requestLog: MockOllamaRequest[];
  close(): Promise<void>;
  resetLog(): void;
  getLogByComponent(component: string): MockOllamaRequest[];
  getCallCount(): number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: MockOllamaConfig = {
  mode: 'happy',
  timeoutDelayMs: 130_000,
};

// ---------------------------------------------------------------------------
// Component routing patterns (checked in order, first match wins)
// ---------------------------------------------------------------------------

interface RouteEntry {
  pattern: string;
  component: string;
}

const ROUTE_TABLE: RouteEntry[] = [
  { pattern: 'web page classifier', component: 'classifier' },
  { pattern: 'data extraction expert', component: 'extractor' },
  { pattern: 'web crawl link evaluator', component: 'link-evaluator' },
  { pattern: 'analyze unmapped fields', component: 'field-proposer' },
  { pattern: 'synonym detection', component: 'synonym-detector' },
  { pattern: 'data normalization expert', component: 'normalization-proposer' },
  { pattern: 'trustworthiness', component: 'source-trust-evaluator' },
  { pattern: 'entity resolution', component: 'entity-matcher' },
  { pattern: 'Infer missing', component: 'gap-filler' },
  { pattern: 'ConfigAction', component: 'conversation' },
];

function resolveComponent(systemPrompt: string): string {
  for (const entry of ROUTE_TABLE) {
    if (systemPrompt.includes(entry.pattern)) {
      return entry.component;
    }
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Canned response handlers
// ---------------------------------------------------------------------------

function handleClassifier(userPrompt: string): object {
  const lc = userPrompt.toLowerCase();

  if (lc.includes('listing') || (lc.includes('<a') && (lc.match(/<a /g) || []).length >= 3)) {
    return {
      classification: 'multiple_entries',
      strategy: 'links_only',
      confidence: 0.95,
      reasoning: 'Product listing page with multiple items',
    };
  }

  if (lc.includes('widget pro')) {
    return {
      classification: 'single_entry',
      strategy: 'full_extraction',
      estimatedEntryCount: 1,
      confidence: 0.92,
      reasoning: 'Single product page',
    };
  }

  if (lc.includes('carbonara')) {
    return {
      classification: 'single_entry',
      strategy: 'full_extraction',
      estimatedEntryCount: 1,
      confidence: 0.9,
      reasoning: 'Recipe page',
    };
  }

  if (lc.includes('comparison') || lc.includes('table')) {
    return {
      classification: 'multiple_entries',
      strategy: 'list_extraction',
      estimatedEntryCount: 3,
      confidence: 0.88,
      reasoning: 'Product comparison table',
    };
  }

  if (lc.includes('about')) {
    return {
      classification: 'irrelevant',
      strategy: 'skip',
      confidence: 0.95,
      reasoning: 'Company info, no extractable data',
    };
  }

  if (lc.includes('review') || lc.includes('blog')) {
    return {
      classification: 'partial',
      strategy: 'full_extraction',
      confidence: 0.6,
      reasoning: 'Mixed content — partial product data',
    };
  }

  if (lc.includes('page 2') || lc.includes('pagination') || lc.includes('/page/')) {
    return {
      classification: 'navigation',
      strategy: 'links_only',
      confidence: 0.85,
      reasoning: 'Pagination page',
    };
  }

  return {
    classification: 'irrelevant',
    strategy: 'skip',
    confidence: 0.5,
    reasoning: 'Unrecognized',
  };
}

function handleExtractor(userPrompt: string, emptyUnmapped: boolean): object {
  const lc = userPrompt.toLowerCase();

  // Detect re-extraction: schema in prompt contains evolved fields
  const hasSchemaWithBrand =
    lc.includes('"brand"') || lc.includes("'brand'") || lc.includes('brand');
  const hasSchemaWithCuisine =
    lc.includes('"cuisine"') || lc.includes("'cuisine'") || lc.includes('cuisine');

  // More precise schema detection: look for brand/cuisine in the schema section
  // The system prompt typically includes the schema fields. We check if these appear
  // as field definitions (not just in the HTML content) by checking the system prompt area.
  const isReExtraction = (fieldName: string): boolean => {
    // Look for field name appearing in a schema-like context before the HTML content
    // Schema fields are typically listed before the user prompt content
    const schemaIndicators = [
      `"name": "${fieldName}"`,
      `"name":"${fieldName}"`,
      `name: ${fieldName}`,
      `field.*${fieldName}`,
    ];
    return schemaIndicators.some((indicator) => {
      if (indicator.includes('.*')) {
        return new RegExp(indicator).test(userPrompt);
      }
      return userPrompt.includes(indicator);
    });
  };

  const brandInSchema = isReExtraction('brand');
  const cuisineInSchema = isReExtraction('cuisine');

  // Widget Pro Deluxe — check before Widget Pro since "Widget Pro" is a substring
  if (lc.includes('widget pro deluxe') || lc.includes('widget-pro-deluxe')) {
    const data: Record<string, unknown> = {
      title: 'Widget Pro',
      price: '$34.99',
      imageUrl: 'https://example.com/widget-deluxe.jpg',
      description: 'The deluxe widget',
    };
    let unmapped: object[] = [{ name: 'brand', value: 'Acme', suggestedType: 'string' }];

    if (brandInSchema) {
      data.brand = 'Acme';
      unmapped = [];
    }
    if (emptyUnmapped) unmapped = [];

    return { data, _unmapped: unmapped, confidence: 0.89 };
  }

  // Widget Pro
  if (lc.includes('widget pro') || lc.includes('widget-pro')) {
    const data: Record<string, unknown> = {
      title: 'Widget Pro',
      price: '$29.99',
      imageUrl: 'https://example.com/widget.jpg',
      description: 'The finest widget',
    };
    let unmapped: object[] = [{ name: 'brand', value: 'Acme', suggestedType: 'string' }];

    if (brandInSchema) {
      data.brand = 'Acme';
      unmapped = [];
    }
    if (emptyUnmapped) unmapped = [];

    return { data, _unmapped: unmapped, confidence: 0.91 };
  }

  // Pasta Carbonara
  if (lc.includes('carbonara')) {
    const data: Record<string, unknown> = {
      title: 'Pasta Carbonara',
      cookTime: '25 min',
      servings: '4',
    };
    let unmapped: object[] = [
      { name: 'cuisine', value: 'Italian', suggestedType: 'string' },
      {
        name: 'ingredients',
        value: ['pasta', 'eggs', 'pecorino', 'guanciale'],
        suggestedType: 'array',
      },
    ];

    if (cuisineInSchema) {
      data.cuisine = 'Italian';
      data.ingredients = ['pasta', 'eggs', 'pecorino', 'guanciale'];
      unmapped = [];
    }
    if (emptyUnmapped) unmapped = [];

    return { data, _unmapped: unmapped, confidence: 0.93 };
  }

  // Comparison table — route by specific widget names
  if (lc.includes('widget a')) {
    return {
      data: { title: 'Widget A', price: '$19.99' },
      _unmapped: [],
      confidence: 0.85,
    };
  }
  if (lc.includes('widget b')) {
    return {
      data: { title: 'Widget B', price: '$24.99' },
      _unmapped: [],
      confidence: 0.85,
    };
  }
  if (lc.includes('widget c')) {
    return {
      data: { title: 'Widget C', price: '$29.99' },
      _unmapped: [],
      confidence: 0.85,
    };
  }

  // Comparison page (batch or first item fallback)
  if (lc.includes('comparison') || lc.includes('side-by-side')) {
    return {
      data: { title: 'Widget A', price: '$19.99' },
      _unmapped: [],
      confidence: 0.85,
    };
  }

  // Blog review
  if (lc.includes('review') || lc.includes('blog')) {
    return {
      data: { title: 'Widget Pro Review' },
      _unmapped: [],
      confidence: 0.55,
    };
  }

  // Default extraction
  return {
    data: { title: 'Unknown' },
    _unmapped: [],
    confidence: 0.5,
  };
}

function handleLinkEvaluator(userPrompt: string): object {
  const lc = userPrompt.toLowerCase();

  // Depth-2 links from a product page
  if (lc.includes('widget-pro-deluxe') || lc.includes('widget pro deluxe')) {
    return [
      {
        url: '/products/widget-pro-deluxe',
        relevanceScore: 0.9,
        expectedContent: 'single_entry',
        priority: 'high',
        reasoning: 'Related product',
      },
    ];
  }

  // Pagination links
  if (lc.includes('/page/2') || lc.includes('page 2')) {
    return [
      {
        url: '/page/2',
        relevanceScore: 0.8,
        expectedContent: 'listing',
        priority: 'medium',
        reasoning: 'More listings',
      },
    ];
  }

  // Main listing page links (the most common case)
  return [
    {
      url: '/products/widget-pro',
      relevanceScore: 0.95,
      expectedContent: 'single_entry',
      priority: 'high',
      reasoning: 'Product page',
    },
    {
      url: '/recipes/pasta-carbonara',
      relevanceScore: 0.9,
      expectedContent: 'single_entry',
      priority: 'high',
      reasoning: 'Recipe content',
    },
    {
      url: '/products/comparison',
      relevanceScore: 0.85,
      expectedContent: 'listing',
      priority: 'medium',
      reasoning: 'Product data',
    },
    {
      url: '/about',
      relevanceScore: 0.3,
      expectedContent: 'unknown',
      priority: 'low',
      reasoning: 'Might contain data',
    },
    {
      url: '/blog/review',
      relevanceScore: 0.6,
      expectedContent: 'single_entry',
      priority: 'medium',
      reasoning: 'Product review',
    },
    {
      url: 'https://twitter.com/spatula',
      relevanceScore: 0.05,
      expectedContent: 'unknown',
      priority: 'low',
      reasoning: 'External domain',
    },
    {
      url: '/admin',
      relevanceScore: 0.7,
      expectedContent: 'unknown',
      priority: 'medium',
      reasoning: 'Might contain data',
    },
  ];
}

function handleFieldProposer(): object {
  return {
    proposals: [
      {
        name: 'brand',
        description: 'Product brand name',
        type: 'string',
        required: false,
        reasoning: 'Found in 2 of 5 product extractions',
        confidence: 0.85,
        relevance: {
          globalFrequency: 0.4,
          categoryBreakdown: [],
          classification: 'categorical_optional',
          applicableCategories: ['product'],
        },
      },
      {
        name: 'cuisine',
        description: 'Cuisine type',
        type: 'string',
        required: false,
        reasoning: 'Found in recipe extractions',
        confidence: 0.8,
        relevance: {
          globalFrequency: 0.2,
          categoryBreakdown: [],
          classification: 'categorical_optional',
          applicableCategories: ['recipe'],
        },
      },
    ],
  };
}

function handleNormalization(): object {
  return {
    rules: [
      {
        fieldName: 'price',
        rule: { type: 'currency', config: { currency: 'USD' } },
        examples: [{ before: '$29.99', after: 29.99 }],
        reasoning: 'Standardize price to numeric USD',
        confidence: 0.95,
      },
    ],
    enumUpdates: [],
  };
}

function handleSourceTrustEvaluator(): object {
  return {
    rankings: [
      {
        domain: 'localhost',
        trustLevel: 'high',
        reasoning: 'Primary crawl target',
      },
    ],
  };
}

function handleEntityMatcher(userPrompt: string): object {
  // The entity-matcher sends extractions as JSON array in the user prompt
  const jsonMatch = userPrompt.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return { groups: [] };

  try {
    const extractions = JSON.parse(jsonMatch[0]) as Array<{
      id: string;
      data: Record<string, unknown>;
    }>;

    // Group by title field
    const byTitle = new Map<string, string[]>();
    for (const ext of extractions) {
      const title = String(ext.data?.title ?? '');
      if (!byTitle.has(title)) byTitle.set(title, []);
      byTitle.get(title)!.push(ext.id);
    }

    return {
      groups: [...byTitle.entries()].map(([title, ids]) => ({
        extractionIds: ids,
        reasoning: ids.length > 1 ? `Same title: ${title}` : 'Unique entity',
        confidence: ids.length > 1 ? 0.88 : 1.0,
      })),
    };
  } catch {
    return { groups: [] };
  }
}

function handleConversation(messages: Array<{ role: string; content: string }>): object {
  // Count user messages in the conversation history
  const userMessageCount = messages.filter((m) => m.role === 'user').length;

  switch (userMessageCount) {
    case 1:
      return {
        response: "I'll set up a product scraping project for example.com.",
        actions: [
          {
            type: 'set_job_name',
            id: randomUUID(),
            reasoning: 'Project name',
            payload: { name: 'Example Products' },
          },
          {
            type: 'add_seed_urls',
            id: randomUUID(),
            reasoning: 'Seed URL',
            payload: { urls: [{ url: 'https://example.com' }] },
          },
        ],
      };

    case 2:
      return {
        response: 'Added brand as a tracked field.',
        actions: [
          {
            type: 'add_user_field',
            id: randomUUID(),
            reasoning: 'User requested',
            payload: {
              field: {
                name: 'brand',
                type: 'string',
                required: false,
                description: 'Product brand',
              },
            },
          },
        ],
      };

    case 3:
    default:
      return {
        response: 'Starting the crawl!',
        actions: [
          {
            type: 'confirm_and_start',
            id: randomUUID(),
            reasoning: 'User confirmed',
            payload: {},
          },
        ],
      };
  }
}

// ---------------------------------------------------------------------------
// Ollama response wrapper
// ---------------------------------------------------------------------------

function wrapOllamaResponse(response: object, model: string): object {
  return {
    message: { content: JSON.stringify(response) },
    model,
    done: true,
    prompt_eval_count: 150,
    eval_count: 80,
  };
}

// ---------------------------------------------------------------------------
// Error injection helpers
// ---------------------------------------------------------------------------

function makeMalformedJsonResponse(model: string): object {
  return {
    message: { content: '{broken json!!!' },
    model,
    done: true,
    prompt_eval_count: 150,
    eval_count: 80,
  };
}

function makeZodFailureResponse(component: string, model: string): object {
  // Return valid JSON but missing required `confidence` field
  let broken: object;
  switch (component) {
    case 'classifier':
      broken = { classification: 'single_entry', strategy: 'full_extraction', reasoning: 'test' };
      break;
    case 'extractor':
      broken = { data: { title: 'Broken' }, _unmapped: [] };
      break;
    case 'field-proposer':
      broken = { proposals: [{ name: 'broken', type: 'string' }] };
      break;
    default:
      broken = { incomplete: true };
      break;
  }
  return {
    message: { content: JSON.stringify(broken) },
    model,
    done: true,
    prompt_eval_count: 150,
    eval_count: 80,
  };
}

// ---------------------------------------------------------------------------
// Request body parsing
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Main server
// ---------------------------------------------------------------------------

export async function startMockOllama(
  config?: Partial<MockOllamaConfig>,
): Promise<MockOllamaServer> {
  const cfg: MockOllamaConfig = { ...DEFAULT_CONFIG, ...config };
  const requestLog: MockOllamaRequest[] = [];
  const componentCallCounts = new Map<string, number>();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Only accept POST to /api/chat
    if (req.method !== 'POST' || req.url !== '/api/chat') {
      // Also support GET /api/tags for availability checks
      if (req.method === 'GET' && req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'mock-model' }] }));
        return;
      }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Only POST /api/chat is supported' }));
      return;
    }

    let rawBody: string;
    try {
      rawBody = await readBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to read request body' }));
      return;
    }

    if (!rawBody) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing request body' }));
      return;
    }

    let body: {
      model: string;
      messages: Array<{ role: string; content: string }>;
      stream?: boolean;
      options?: object;
      format?: string;
    };

    try {
      body = JSON.parse(rawBody);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON in request body' }));
      return;
    }

    if (!body.messages || body.messages.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No messages in request' }));
      return;
    }

    const systemPrompt = body.messages[0]?.content ?? '';
    const lastUserMessage = [...body.messages].reverse().find((m) => m.role === 'user');
    const userPrompt = lastUserMessage?.content ?? '';
    const model = body.model ?? 'mock-model';

    // Resolve component
    const component = resolveComponent(systemPrompt);

    // Track call count per component
    const currentCount = (componentCallCounts.get(component) ?? 0) + 1;
    componentCallCounts.set(component, currentCount);

    // Log the request
    requestLog.push({
      timestamp: Date.now(),
      model,
      component,
      systemPromptPreview: systemPrompt.slice(0, 200),
      userPromptPreview: userPrompt.slice(0, 200),
      fullSystemPrompt: systemPrompt,
      fullUserPrompt: userPrompt,
    });

    // -----------------------------------------------------------------------
    // Error injection — check before routing to happy-path handlers
    // -----------------------------------------------------------------------

    const shouldFail =
      cfg.mode !== 'happy' &&
      (!cfg.failOnComponent || cfg.failOnComponent === component) &&
      (!cfg.failOnNthCall || currentCount === cfg.failOnNthCall);

    if (shouldFail) {
      switch (cfg.mode) {
        case 'malformed-json': {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(makeMalformedJsonResponse(model)));
          return;
        }

        case 'timeout': {
          const delay = cfg.timeoutDelayMs ?? 130_000;
          setTimeout(() => {
            // Just close the connection after the delay without sending a response
            res.end();
          }, delay);
          return;
        }

        case 'zod-failure': {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(makeZodFailureResponse(component, model)));
          return;
        }
      }
    }

    // -----------------------------------------------------------------------
    // Happy-path routing
    // -----------------------------------------------------------------------

    let response: object;

    switch (component) {
      case 'classifier':
        response = handleClassifier(userPrompt);
        break;

      case 'extractor':
        response = handleExtractor(userPrompt, cfg.emptyUnmapped ?? false);
        break;

      case 'link-evaluator':
        response = handleLinkEvaluator(userPrompt);
        break;

      case 'field-proposer':
        response = handleFieldProposer();
        break;

      case 'synonym-detector':
        response = { merges: [] };
        break;

      case 'normalization-proposer':
        response = handleNormalization();
        break;

      case 'source-trust-evaluator':
        response = handleSourceTrustEvaluator();
        break;

      case 'entity-matcher':
        response = handleEntityMatcher(userPrompt);
        break;

      case 'gap-filler':
        response = { inferences: [] };
        break;

      case 'conversation':
        response = handleConversation(body.messages);
        break;

      default:
        response = { error: `Unknown component: ${component}` };
        break;
    }

    const ollamaResponse = wrapOllamaResponse(response, model);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ollamaResponse));
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });

  return {
    port,
    requestLog,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
    resetLog: () => {
      requestLog.length = 0;
      componentCallCounts.clear();
    },
    getLogByComponent: (comp: string) => requestLog.filter((entry) => entry.component === comp),
    getCallCount: () => requestLog.length,
  };
}
