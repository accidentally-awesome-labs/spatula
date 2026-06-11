import { createStore } from 'zustand/vanilla';
import type { StoreApi } from 'zustand/vanilla';
import {
  DefaultConfigExecutor,
  type ConfigAction,
  type JobConfig,
  type ConfigValidationResult,
} from '@spatula/core';
import type { Entity, EntityWithProvenance } from '@spatula/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  actions?: ConfigAction[];
  timestamp?: number;
}

/** Minimal shape for pipeline actions fetched from the API. */
export interface PendingAction {
  id: string;
  type: string;
  confidence?: number;
  reasoning?: string;
  source?: string;
  status?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

export type CliMode = 'conversational' | 'dashboard' | 'review' | 'explorer';

export interface CliState {
  // Mode
  mode: CliMode;
  setMode: (mode: CliMode) => void;

  // Config (being built in conversational mode)
  config: JobConfig;
  applyActions: (actions: ConfigAction[]) => void;
  resetConfig: () => void;
  validateConfig: () => ConfigValidationResult;

  // Action history
  actionHistory: ConfigAction[];

  // Chat messages
  messages: ChatMessage[];
  addMessage: (message: Omit<ChatMessage, 'timestamp'>) => void;
  clearMessages: () => void;

  // Loading state
  isLoading: boolean;
  setLoading: (loading: boolean) => void;

  // Active job
  activeJobId: string | null;
  setActiveJobId: (id: string | null) => void;

  // Error
  error: string | null;
  setError: (error: string | null) => void;

  // Job runtime state (fetched from API for dashboard/review)
  jobData: Record<string, unknown> | null;
  setJobData: (data: Record<string, unknown> | null) => void;

  pendingActions: PendingAction[];
  setPendingActions: (actions: PendingAction[]) => void;
  removeAction: (actionId: string) => void;

  schemaData: Record<string, unknown> | null;
  setSchemaData: (schema: Record<string, unknown> | null) => void;

  recentActions: PendingAction[];
  setRecentActions: (actions: PendingAction[]) => void;

  entityPreviews: Record<string, unknown>[];
  setEntityPreviews: (entities: Record<string, unknown>[]) => void;

  reviewIndex: number;
  setReviewIndex: (index: number) => void;

  // Explorer state
  entities: Entity[];
  totalEntityCount: number;
  currentEntityPage: number;
  selectedEntityIndex: number;
  expandedEntity: EntityWithProvenance | null;
  filterQuery: string;
  filterMode: 'local' | 'ai';
  filterFocused: boolean;

  // Explorer setters
  setEntities: (entities: Entity[]) => void;
  setTotalEntityCount: (count: number) => void;
  setCurrentEntityPage: (page: number) => void;
  setSelectedEntityIndex: (index: number) => void;
  setExpandedEntity: (entity: EntityWithProvenance | null) => void;
  setFilterQuery: (query: string) => void;
  setFilterMode: (mode: 'local' | 'ai') => void;
  setFilterFocused: (focused: boolean) => void;
}

export type CliStore = StoreApi<CliState>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function createEmptyConfig(tenantId: string): JobConfig {
  return {
    tenantId,
    name: '',
    description: '',
    seedUrls: [],
    crawl: { maxDepth: 2, maxPages: 1000, concurrency: 5, crawlerType: 'playwright' },
    schema: { mode: 'discovery' },
    llm: { primaryModel: 'deepseek/deepseek-v4-pro' },
  };
}

const executor = new DefaultConfigExecutor();

/**
 * Create a Zustand vanilla store for CLI state management.
 * Each store is scoped to a single tenant.
 */
export function createCliStore(tenantId: string): CliStore {
  const emptyConfig = createEmptyConfig(tenantId);

  return createStore<CliState>()((set, get) => ({
    // Mode
    mode: 'conversational',
    setMode: (mode) => set({ mode }),

    // Config
    config: emptyConfig,
    applyActions: (actions) => {
      const { config, actionHistory } = get();
      const nextConfig = executor.applyBatch(config, actions);
      set({
        config: nextConfig,
        actionHistory: [...actionHistory, ...actions],
      });
    },
    resetConfig: () => {
      set({
        config: createEmptyConfig(tenantId),
        actionHistory: [],
      });
    },
    validateConfig: () => {
      return executor.validate(get().config);
    },

    // Action history
    actionHistory: [],

    // Chat messages
    messages: [],
    addMessage: (message) => {
      const chatMessage: ChatMessage = {
        ...message,
        timestamp: Date.now(),
      };
      set((state) => ({
        messages: [...state.messages, chatMessage],
      }));
    },
    clearMessages: () => set({ messages: [] }),

    // Loading state
    isLoading: false,
    setLoading: (loading) => set({ isLoading: loading }),

    // Active job
    activeJobId: null,
    setActiveJobId: (id) => set({ activeJobId: id }),

    // Error
    error: null,
    setError: (error) => set({ error }),

    // Job runtime state
    jobData: null,
    setJobData: (data) => set({ jobData: data }),

    pendingActions: [],
    setPendingActions: (actions) => set({ pendingActions: actions }),
    removeAction: (actionId) =>
      set((state) => ({
        pendingActions: state.pendingActions.filter((a) => a.id !== actionId),
      })),

    schemaData: null,
    setSchemaData: (schema) => set({ schemaData: schema }),

    recentActions: [],
    setRecentActions: (actions) => set({ recentActions: actions }),

    entityPreviews: [],
    setEntityPreviews: (entities) => set({ entityPreviews: entities }),

    reviewIndex: 0,
    setReviewIndex: (index) => {
      const max = Math.max(0, get().pendingActions.length - 1);
      set({ reviewIndex: Math.max(0, Math.min(index, max)) });
    },

    // Explorer state
    entities: [],
    totalEntityCount: 0,
    currentEntityPage: 0,
    selectedEntityIndex: 0,
    expandedEntity: null,
    filterQuery: '',
    filterMode: 'local',
    filterFocused: false,

    // Explorer setters
    setEntities: (entities) => set({ entities }),
    setTotalEntityCount: (totalEntityCount) => set({ totalEntityCount }),
    setCurrentEntityPage: (currentEntityPage) => set({ currentEntityPage }),
    setSelectedEntityIndex: (selectedEntityIndex) => set({ selectedEntityIndex }),
    setExpandedEntity: (expandedEntity) => set({ expandedEntity }),
    setFilterQuery: (filterQuery) => set({ filterQuery }),
    setFilterMode: (filterMode) => set({ filterMode }),
    setFilterFocused: (filterFocused) => set({ filterFocused }),
  }));
}
