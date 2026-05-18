/**
 * `spatula new` — launch interactive conversational mode to build a job config.
 *
 * Creates the store, API client, LLM client, and conversation service, then
 * renders the Ink TUI and listens for new user messages to drive the
 * conversation loop.
 */

import React from 'react';
import { render } from 'ink';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { OpenRouterClient } from '@spatula/core';
import type { ConfigAction, JobConfig } from '@spatula/core';
import { createCliStore } from '../store/index.js';
import { SpatulaApiClient } from '../api/client.js';
import { ConfigConversationService } from '../services/config-conversation.js';
import { App } from '../components/App.js';
import type { CliStore } from '../store/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NewCommandOptions {
  apiUrl: string;
  tenantId?: string;
  openrouterApiKey?: string;
  model?: string;
}

// ---------------------------------------------------------------------------
// YAML serialisation
// ---------------------------------------------------------------------------

/**
 * Convert a JobConfig into the minimal spatula.yaml representation.
 * Default values are omitted to keep the file clean.
 */
export function configToYaml(config: JobConfig): string {
  const yamlObj: Record<string, unknown> = {
    name: config.name,
    description: config.description,
    seeds: config.seedUrls,
  };
  if (config.crawl.maxDepth !== 2) yamlObj.depth = config.crawl.maxDepth;
  if (config.crawl.maxPages !== 1000) yamlObj.limit = config.crawl.maxPages;
  if (config.crawl.crawlerType !== 'playwright') yamlObj.crawler = config.crawl.crawlerType;
  if (config.schema.userFields?.length) {
    yamlObj.fields = config.schema.userFields.map((f) => ({
      field: f.name,
      type: f.type,
      ...(f.required ? { required: true } : {}),
    }));
  }
  if (config.schema.mode && config.schema.mode !== 'discovery') {
    yamlObj.schema = { mode: config.schema.mode };
  }
  return stringifyYaml(yamlObj, { lineWidth: 0 });
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = 'anthropic/claude-sonnet-4-20250514';

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Handle a new user message: send to LLM, apply returned actions, add AI
 * response, and handle special `confirm_and_start` action.
 */
async function handleUserMessage(
  userMessage: string,
  store: CliStore,
  conversationService: ConfigConversationService,
  apiClient: SpatulaApiClient | null,
): Promise<void> {
  const state = store.getState();
  state.setLoading(true);
  state.setError(null);

  try {
    // Exclude the just-added user message from history (processMessage appends it)
    const result = await conversationService.processMessage(
      userMessage,
      state.config,
      state.messages.slice(0, -1),
    );

    // Apply config actions from the AI response
    if (result.actions.length > 0) {
      // Check for confirm_and_start before applying
      const confirmAction = result.actions.find(
        (a: ConfigAction) => a.type === 'confirm_and_start',
      );

      // Apply all actions (including confirm_and_start — the executor handles it)
      store.getState().applyActions(result.actions);

      if (confirmAction) {
        await handleConfirmAndStart(store, apiClient, result.responseText);
        return;
      }
    }

    // Add the AI response message
    store.getState().addMessage({
      role: 'assistant',
      content: result.responseText,
      actions: result.actions,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error occurred';
    store.getState().setError(message);
    store.getState().addMessage({
      role: 'assistant',
      content: `An error occurred: ${message}`,
    });
  } finally {
    store.getState().setLoading(false);
  }
}

/**
 * Validate configuration, create the job via the API (or write local files),
 * and start it.
 */
async function handleConfirmAndStart(
  store: CliStore,
  apiClient: SpatulaApiClient | null,
  responseText: string,
): Promise<void> {
  const state = store.getState();
  const validation = state.validateConfig();

  if (!validation.valid) {
    const issues = validation.missing.map((m: string) => `  - ${m}`).join('\n');
    state.addMessage({
      role: 'assistant',
      content: `The configuration is incomplete:\n${issues}\n\nPlease address these and try again.`,
    });
    return;
  }

  // Local mode — no API client configured
  if (!apiClient) {
    const cwd = process.cwd();
    const yamlPath = join(cwd, 'spatula.yaml');
    const spatulaDir = join(cwd, '.spatula');
    const yamlContent = configToYaml(state.config as unknown as JobConfig);
    writeFileSync(yamlPath, yamlContent, 'utf-8');
    if (!existsSync(spatulaDir)) mkdirSync(spatulaDir, { recursive: true });
    state.addMessage({
      role: 'assistant',
      content:
        'Project created! Files written:\n  - spatula.yaml\n  - .spatula/\n\nRun `spatula run` to start crawling.',
    });
    return;
  }

  try {
    const job = await apiClient.createJob(state.config as unknown as Record<string, unknown>);
    const jobId = String(job.id);

    await apiClient.startJob(jobId);

    state.setActiveJobId(jobId);
    state.addMessage({
      role: 'assistant',
      content: `${responseText}\n\nJob created and started! Job ID: ${jobId}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create job';
    state.setError(message);
    state.addMessage({
      role: 'assistant',
      content: `${responseText}\n\nFailed to start the job: ${message}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Launch the interactive conversational mode.
 */
export async function runNewCommand(options: NewCommandOptions): Promise<void> {
  const { apiUrl, model } = options;

  const openrouterApiKey = options.openrouterApiKey ?? process.env.OPENROUTER_API_KEY;
  if (!openrouterApiKey) {
    console.error('OPENROUTER_API_KEY is required for conversational mode.');
    console.error('To create a project without an LLM, use `spatula init <url>` instead.');
    process.exit(1);
  }

  const tenantId = options.tenantId ?? 'local';
  const store = createCliStore(tenantId);
  const apiClient = options.tenantId ? new SpatulaApiClient(apiUrl, options.tenantId) : null;
  const llmClient = new OpenRouterClient({ apiKey: openrouterApiKey });
  const conversationService = new ConfigConversationService(llmClient, model ?? DEFAULT_MODEL);

  // Subscribe to store — process new user messages automatically
  const unsubscribe = store.subscribe((state, prevState) => {
    if (
      state.messages.length > prevState.messages.length &&
      state.messages[state.messages.length - 1].role === 'user'
    ) {
      const lastMessage = state.messages[state.messages.length - 1];
      handleUserMessage(lastMessage.content, store, conversationService, apiClient);
    }
  });

  // Callbacks for the App component
  const handleStartJob = (_config: Record<string, unknown>): void => {
    // Job start is handled through the conversation flow (confirm_and_start action).
    // This callback exists for direct start-job requests from the UI if needed.
  };

  const handleExit = (): void => {
    unsubscribe();
  };

  // Render the Ink application
  const { waitUntilExit } = render(
    <App store={store} apiClient={apiClient} onStartJob={handleStartJob} onExit={handleExit} />,
  );

  // Add a welcome message
  store.getState().addMessage({
    role: 'assistant',
    content:
      'Welcome to Spatula! Tell me what data you want to collect and I\'ll help you set up a crawl job.\n\nFor example: "I want to scrape product listings from example.com"',
  });

  await waitUntilExit();
  unsubscribe();
}
