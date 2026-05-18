# Phase 9b: Dashboard + Review Mode — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add live-updating crawl monitoring (Dashboard mode) and interactive action review (Review mode) to the Spatula CLI, so users can monitor job progress and approve/reject AI-proposed actions directly from the terminal.

**Architecture:** Dashboard polls the API for job state (progress, schema, entities) and displays it in a multi-panel layout. Review mode fetches pending actions and presents them one at a time with evidence, reasoning, and impact diff — the user approves/rejects with single keypresses. Both modes share a `useJobPolling` hook for periodic API fetching. A `useKeyboard` hook handles global mode switching and per-mode hotkeys. The existing Zustand store is extended with job runtime state (job data, actions, schema, entities). All new components follow the existing Ink 5 / React 18 patterns established in Phase 9a.

**Tech Stack:** Ink 5 (React 18 for terminals), Zustand 5 (state), `ink-testing-library` for tests, `SpatulaApiClient` for API calls, vitest

---

## Task 1: Extend Store with Job Runtime State

**Files:**

- Modify: `apps/cli/src/store/index.ts`
- Test: `apps/cli/tests/unit/store/index.test.ts`

**Context:** The store currently tracks local config-building state (conversational mode). Dashboard and Review modes need to track live job data from the API: the job object, pending pipeline actions, schema, and sample entities. These are separate from the config-building state — they represent server-side state fetched via polling.

**Step 1: Write the failing tests**

Add these tests to the existing `apps/cli/tests/unit/store/index.test.ts`:

```typescript
describe('job runtime state', () => {
  it('stores and retrieves job data', () => {
    const store = createCliStore('test-tenant');
    const job = { id: 'job-1', name: 'Test', status: 'running', stats: { pagesCrawled: 10 } };
    store.getState().setJobData(job);
    expect(store.getState().jobData).toEqual(job);
  });

  it('clears job data', () => {
    const store = createCliStore('test-tenant');
    store.getState().setJobData({ id: 'job-1' });
    store.getState().setJobData(null);
    expect(store.getState().jobData).toBeNull();
  });

  it('stores pending actions', () => {
    const store = createCliStore('test-tenant');
    const actions = [
      { id: 'a1', type: 'add_field', status: 'pending_review', confidence: 0.9 },
      { id: 'a2', type: 'merge_fields', status: 'pending_review', confidence: 0.8 },
    ];
    store.getState().setPendingActions(actions);
    expect(store.getState().pendingActions).toHaveLength(2);
  });

  it('removes action from pending list after approval/rejection', () => {
    const store = createCliStore('test-tenant');
    store.getState().setPendingActions([
      { id: 'a1', type: 'add_field', status: 'pending_review', confidence: 0.9 },
      { id: 'a2', type: 'merge_fields', status: 'pending_review', confidence: 0.8 },
    ]);
    store.getState().removeAction('a1');
    expect(store.getState().pendingActions).toHaveLength(1);
    expect(store.getState().pendingActions[0].id).toBe('a2');
  });

  it('stores schema data', () => {
    const store = createCliStore('test-tenant');
    const schema = { mode: 'hybrid', fields: [], version: 3 };
    store.getState().setSchemaData(schema);
    expect(store.getState().schemaData).toEqual(schema);
  });

  it('stores entity previews', () => {
    const store = createCliStore('test-tenant');
    const entities = [{ id: 'e1', mergedData: { name: 'HD-650' } }];
    store.getState().setEntityPreviews(entities);
    expect(store.getState().entityPreviews).toEqual(entities);
  });

  it('tracks current review index', () => {
    const store = createCliStore('test-tenant');
    store.getState().setReviewIndex(3);
    expect(store.getState().reviewIndex).toBe(3);
  });

  it('clamps review index to 0 minimum', () => {
    const store = createCliStore('test-tenant');
    store.getState().setReviewIndex(-1);
    expect(store.getState().reviewIndex).toBe(0);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/cli test -- tests/unit/store/index.test.ts`
Expected: FAIL — `setJobData`, `jobData`, etc. do not exist on state.

**Step 3: Implement store extensions**

In `apps/cli/src/store/index.ts`, add the new state fields and actions to `CliState` and the store factory:

```typescript
// Add to CliState interface (after existing fields):

  // Job runtime state (fetched from API for dashboard/review)
  jobData: Record<string, unknown> | null;
  setJobData: (data: Record<string, unknown> | null) => void;

  pendingActions: Record<string, unknown>[];
  setPendingActions: (actions: Record<string, unknown>[]) => void;
  removeAction: (actionId: string) => void;

  schemaData: Record<string, unknown> | null;
  setSchemaData: (schema: Record<string, unknown> | null) => void;

  entityPreviews: Record<string, unknown>[];
  setEntityPreviews: (entities: Record<string, unknown>[]) => void;

  reviewIndex: number;
  setReviewIndex: (index: number) => void;
```

Add the implementations inside the `createStore` callback:

```typescript
    // Job runtime state
    jobData: null,
    setJobData: (data) => set({ jobData: data }),

    pendingActions: [],
    setPendingActions: (actions) => set({ pendingActions: actions }),
    removeAction: (actionId) =>
      set((state) => ({
        pendingActions: state.pendingActions.filter(
          (a) => (a as Record<string, unknown>).id !== actionId,
        ),
      })),

    schemaData: null,
    setSchemaData: (schema) => set({ schemaData: schema }),

    entityPreviews: [],
    setEntityPreviews: (entities) => set({ entityPreviews: entities }),

    reviewIndex: 0,
    setReviewIndex: (index) => set({ reviewIndex: Math.max(0, index) }),
```

**Step 4: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/cli test -- tests/unit/store/index.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add apps/cli/src/store/index.ts apps/cli/tests/unit/store/index.test.ts
git commit -m "feat(cli): extend store with job runtime state for dashboard and review modes"
```

---

## Task 2: useJobPolling Hook

**Files:**

- Create: `apps/cli/src/hooks/useJobPolling.ts`
- Test: `apps/cli/tests/unit/hooks/useJobPolling.test.ts`

**Context:** Both Dashboard and Review modes need to periodically fetch job data from the API. This hook encapsulates the polling logic — it calls the API client methods at a configurable interval and writes results into the store. It returns `{ isPolling, lastError }` for the UI. The hook uses `useEffect` with `setInterval` for polling. It fetches job details, pending actions, schema, and entity previews in parallel on each tick.

**Step 1: Write the failing test**

Create `apps/cli/tests/unit/hooks/useJobPolling.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, act } from 'ink-testing-library';
import { Text } from 'ink';
import { createCliStore } from '../../../src/store/index.js';
import { useJobPolling } from '../../../src/hooks/useJobPolling.js';
import type { SpatulaApiClient } from '../../../src/api/client.js';

function createMockApiClient(overrides: Partial<SpatulaApiClient> = {}): SpatulaApiClient {
  return {
    getJob: vi.fn().mockResolvedValue({ id: 'job-1', name: 'Test Job', status: 'running' }),
    listActions: vi.fn().mockResolvedValue([
      { id: 'a1', type: 'add_field', status: 'pending_review', confidence: 0.9 },
    ]),
    getSchema: vi.fn().mockResolvedValue({ mode: 'hybrid', version: 2 }),
    listEntities: vi.fn().mockResolvedValue([{ id: 'e1', mergedData: { name: 'Test' } }]),
    ...overrides,
  } as unknown as SpatulaApiClient;
}

// Test wrapper component that uses the hook
function TestComponent({
  store,
  apiClient,
  jobId,
  interval,
}: {
  store: ReturnType<typeof createCliStore>;
  apiClient: SpatulaApiClient;
  jobId: string;
  interval?: number;
}) {
  const { isPolling, lastError } = useJobPolling(store, apiClient, jobId, interval);
  return (
    <Text>
      {isPolling ? 'polling' : 'idle'}|{lastError ?? 'none'}
    </Text>
  );
}

describe('useJobPolling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches job data immediately on mount', async () => {
    const store = createCliStore('test-tenant');
    const apiClient = createMockApiClient();

    render(<TestComponent store={store} apiClient={apiClient} jobId="job-1" />);

    // Flush promises from the immediate fetch
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    expect(apiClient.getJob).toHaveBeenCalledWith('job-1');
    expect(store.getState().jobData).toEqual({ id: 'job-1', name: 'Test Job', status: 'running' });
  });

  it('fetches pending actions filtered by status', async () => {
    const store = createCliStore('test-tenant');
    const apiClient = createMockApiClient();

    render(<TestComponent store={store} apiClient={apiClient} jobId="job-1" />);

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    expect(apiClient.listActions).toHaveBeenCalledWith('job-1', { status: 'pending_review' });
    expect(store.getState().pendingActions).toHaveLength(1);
  });

  it('polls at the configured interval', async () => {
    const store = createCliStore('test-tenant');
    const apiClient = createMockApiClient();

    render(<TestComponent store={store} apiClient={apiClient} jobId="job-1" interval={3000} />);

    // Initial fetch
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    expect(apiClient.getJob).toHaveBeenCalledTimes(1);

    // Advance by interval
    await act(async () => {
      vi.advanceTimersByTime(3000);
      await vi.runOnlyPendingTimersAsync();
    });

    expect(apiClient.getJob).toHaveBeenCalledTimes(2);
  });

  it('handles API errors without crashing', async () => {
    const store = createCliStore('test-tenant');
    const apiClient = createMockApiClient({
      getJob: vi.fn().mockRejectedValue(new Error('Network failure')),
    });

    const { lastFrame } = render(
      <TestComponent store={store} apiClient={apiClient} jobId="job-1" />,
    );

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    expect(lastFrame()!).toContain('Network failure');
    // Store should not have been updated with bad data
    expect(store.getState().jobData).toBeNull();
  });

  it('stops polling on unmount', async () => {
    const store = createCliStore('test-tenant');
    const apiClient = createMockApiClient();

    const { unmount } = render(
      <TestComponent store={store} apiClient={apiClient} jobId="job-1" interval={2000} />,
    );

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    unmount();

    await act(async () => {
      vi.advanceTimersByTime(5000);
      await vi.runOnlyPendingTimersAsync();
    });

    // Should only have the initial call, not continued polling
    expect(apiClient.getJob).toHaveBeenCalledTimes(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/cli test -- tests/unit/hooks/useJobPolling.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement useJobPolling hook**

Create `apps/cli/src/hooks/useJobPolling.ts`:

```typescript
import { useEffect, useRef, useState } from 'react';
import type { CliStore } from '../store/index.js';
import type { SpatulaApiClient } from '../api/client.js';

const DEFAULT_INTERVAL = 3000;

export interface UseJobPollingResult {
  isPolling: boolean;
  lastError: string | null;
}

export function useJobPolling(
  store: CliStore,
  apiClient: SpatulaApiClient,
  jobId: string,
  interval: number = DEFAULT_INTERVAL,
): UseJobPollingResult {
  const [isPolling, setIsPolling] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    async function fetchAll(): Promise<void> {
      if (!mountedRef.current) return;
      setIsPolling(true);
      setLastError(null);

      try {
        const [job, actions, schema, entities] = await Promise.all([
          apiClient.getJob(jobId),
          apiClient.listActions(jobId, { status: 'pending_review' }),
          apiClient.getSchema(jobId).catch(() => null),
          apiClient.listEntities(jobId, { limit: 5 }).catch(() => []),
        ]);

        if (!mountedRef.current) return;

        const state = store.getState();
        state.setJobData(job);
        state.setPendingActions(actions as Record<string, unknown>[]);
        if (schema) state.setSchemaData(schema);
        state.setEntityPreviews(entities as Record<string, unknown>[]);
      } catch (err) {
        if (!mountedRef.current) return;
        const message = err instanceof Error ? err.message : 'Unknown error';
        setLastError(message);
      } finally {
        if (mountedRef.current) setIsPolling(false);
      }
    }

    // Immediate fetch
    fetchAll();

    // Periodic polling
    const timer = setInterval(fetchAll, interval);

    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, [store, apiClient, jobId, interval]);

  return { isPolling, lastError };
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/cli test -- tests/unit/hooks/useJobPolling.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add apps/cli/src/hooks/useJobPolling.ts apps/cli/tests/unit/hooks/useJobPolling.test.ts
git commit -m "feat(cli): add useJobPolling hook for periodic API state fetching"
```

---

## Task 3: useKeyboard Hook

**Files:**

- Create: `apps/cli/src/hooks/useKeyboard.ts`
- Test: `apps/cli/tests/unit/hooks/useKeyboard.test.ts`

**Context:** Both Dashboard and Review modes need keyboard navigation. This hook listens to Ink's `useInput` for keypresses and dispatches them to a callback map. It supports single-key bindings (letters, arrows, enter, escape) and modifier combos (ctrl+c). The hook is composable — each mode provides its own key map, and the global mode-switching keys are handled in App.tsx.

**Step 1: Write the failing test**

Create `apps/cli/tests/unit/hooks/useKeyboard.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { useKeyboard } from '../../../src/hooks/useKeyboard.js';
import type { KeyMap } from '../../../src/hooks/useKeyboard.js';

function TestComponent({ keyMap }: { keyMap: KeyMap }) {
  useKeyboard(keyMap);
  return <Text>listening</Text>;
}

describe('useKeyboard', () => {
  it('calls handler when matching key is pressed', () => {
    const handler = vi.fn();
    const keyMap: KeyMap = { d: handler };

    const { stdin } = render(<TestComponent keyMap={keyMap} />);
    stdin.write('d');

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not call handler for unbound keys', () => {
    const handler = vi.fn();
    const keyMap: KeyMap = { d: handler };

    const { stdin } = render(<TestComponent keyMap={keyMap} />);
    stdin.write('x');

    expect(handler).not.toHaveBeenCalled();
  });

  it('supports multiple key bindings', () => {
    const dHandler = vi.fn();
    const rHandler = vi.fn();
    const keyMap: KeyMap = { d: dHandler, r: rHandler };

    const { stdin } = render(<TestComponent keyMap={keyMap} />);
    stdin.write('d');
    stdin.write('r');

    expect(dHandler).toHaveBeenCalledTimes(1);
    expect(rHandler).toHaveBeenCalledTimes(1);
  });

  it('supports arrow key bindings', () => {
    const upHandler = vi.fn();
    const downHandler = vi.fn();
    const keyMap: KeyMap = { upArrow: upHandler, downArrow: downHandler };

    const { stdin } = render(<TestComponent keyMap={keyMap} />);
    // Ink's testing library sends escape sequences for arrow keys
    stdin.write('\u001B[A'); // up arrow
    stdin.write('\u001B[B'); // down arrow

    expect(upHandler).toHaveBeenCalledTimes(1);
    expect(downHandler).toHaveBeenCalledTimes(1);
  });

  it('supports return key binding', () => {
    const handler = vi.fn();
    const keyMap: KeyMap = { return: handler };

    const { stdin } = render(<TestComponent keyMap={keyMap} />);
    stdin.write('\r');

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('supports escape key binding', () => {
    const handler = vi.fn();
    const keyMap: KeyMap = { escape: handler };

    const { stdin } = render(<TestComponent keyMap={keyMap} />);
    stdin.write('\u001B');

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/cli test -- tests/unit/hooks/useKeyboard.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement useKeyboard hook**

Create `apps/cli/src/hooks/useKeyboard.ts`:

```typescript
import { useInput } from 'ink';

export type KeyHandler = () => void;

export interface KeyMap {
  [key: string]: KeyHandler;
}

/**
 * Hook that maps keypresses to handler functions.
 *
 * Supports single character keys ('d', 'r', 'y', 'n'), special keys
 * ('upArrow', 'downArrow', 'return', 'escape', 'tab'), and any other
 * key recognized by Ink's useInput.
 */
export function useKeyboard(keyMap: KeyMap): void {
  useInput((input, key) => {
    // Check special keys first
    if (key.upArrow && keyMap.upArrow) {
      keyMap.upArrow();
      return;
    }
    if (key.downArrow && keyMap.downArrow) {
      keyMap.downArrow();
      return;
    }
    if (key.leftArrow && keyMap.leftArrow) {
      keyMap.leftArrow();
      return;
    }
    if (key.rightArrow && keyMap.rightArrow) {
      keyMap.rightArrow();
      return;
    }
    if (key.return && keyMap.return) {
      keyMap.return();
      return;
    }
    if (key.escape && keyMap.escape) {
      keyMap.escape();
      return;
    }
    if (key.tab && keyMap.tab) {
      keyMap.tab();
      return;
    }

    // Check character keys
    if (input && keyMap[input]) {
      keyMap[input]();
    }
  });
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/cli test -- tests/unit/hooks/useKeyboard.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add apps/cli/src/hooks/useKeyboard.ts apps/cli/tests/unit/hooks/useKeyboard.test.ts
git commit -m "feat(cli): add useKeyboard hook for key binding dispatch"
```

---

## Task 4: ProgressPanel Component

**Files:**

- Create: `apps/cli/src/components/dashboard/ProgressPanel.tsx`
- Test: `apps/cli/tests/unit/components/dashboard/progress-panel.test.tsx`

**Context:** The ProgressPanel is the top-left panel in the dashboard layout. It shows visual progress bars for pages crawled, pages extracted, and pages reconciled, plus action counts. Each bar is a simple ASCII bar chart using block characters. The component receives a job data object (as returned from the API) and renders the progress visualization.

**Step 1: Write the failing test**

Create `apps/cli/tests/unit/components/dashboard/progress-panel.test.tsx`:

```typescript
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { ProgressPanel } from '../../../../src/components/dashboard/ProgressPanel.js';

describe('ProgressPanel', () => {
  it('renders progress bars for all stages', () => {
    const job = {
      status: 'running',
      stats: {
        pagesFound: 100,
        pagesCrawled: 60,
        pagesExtracted: 40,
        pagesReconciled: 20,
        actionsPending: 3,
        actionsApplied: 12,
      },
    };
    const { lastFrame } = render(<ProgressPanel job={job} />);
    const frame = lastFrame()!;

    expect(frame).toContain('Crawled');
    expect(frame).toContain('60');
    expect(frame).toContain('100');
    expect(frame).toContain('Extracted');
    expect(frame).toContain('40');
    expect(frame).toContain('Reconciled');
    expect(frame).toContain('20');
  });

  it('shows percentage for each progress bar', () => {
    const job = {
      status: 'running',
      stats: {
        pagesFound: 200,
        pagesCrawled: 100,
        pagesExtracted: 50,
        pagesReconciled: 0,
        actionsPending: 0,
        actionsApplied: 0,
      },
    };
    const { lastFrame } = render(<ProgressPanel job={job} />);
    const frame = lastFrame()!;

    expect(frame).toContain('50%');
    expect(frame).toContain('25%');
  });

  it('shows action summary', () => {
    const job = {
      status: 'running',
      stats: {
        pagesFound: 50,
        pagesCrawled: 50,
        pagesExtracted: 50,
        pagesReconciled: 50,
        actionsPending: 5,
        actionsApplied: 15,
      },
    };
    const { lastFrame } = render(<ProgressPanel job={job} />);
    const frame = lastFrame()!;

    expect(frame).toContain('5 pending');
    expect(frame).toContain('15 applied');
  });

  it('handles zero total pages gracefully', () => {
    const job = {
      status: 'pending',
      stats: {
        pagesFound: 0,
        pagesCrawled: 0,
        pagesExtracted: 0,
        pagesReconciled: 0,
        actionsPending: 0,
        actionsApplied: 0,
      },
    };
    const { lastFrame } = render(<ProgressPanel job={job} />);
    const frame = lastFrame()!;

    // Should not crash, should show 0%
    expect(frame).toContain('0%');
  });

  it('shows job status', () => {
    const job = {
      status: 'running',
      stats: { pagesFound: 10, pagesCrawled: 5, pagesExtracted: 3, pagesReconciled: 0, actionsPending: 0, actionsApplied: 0 },
    };
    const { lastFrame } = render(<ProgressPanel job={job} />);
    expect(lastFrame()!).toContain('running');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/cli test -- tests/unit/components/dashboard/progress-panel.test.tsx`
Expected: FAIL — module not found.

**Step 3: Implement ProgressPanel**

Create `apps/cli/src/components/dashboard/ProgressPanel.tsx`:

```typescript
import React from 'react';
import { Box, Text } from 'ink';
import { Panel } from '../shared/Panel.js';

export interface ProgressPanelProps {
  job: Record<string, unknown>;
}

const BAR_WIDTH = 20;

function ProgressBar({
  label,
  current,
  total,
  color,
}: {
  label: string;
  current: number;
  total: number;
  color: string;
}): React.ReactElement {
  const ratio = total > 0 ? current / total : 0;
  const filled = Math.round(ratio * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  const percent = Math.round(ratio * 100);

  return (
    <Box>
      <Box width={12}>
        <Text>{label}</Text>
      </Box>
      <Text color={color}>{'█'.repeat(filled)}</Text>
      <Text dimColor>{'░'.repeat(empty)}</Text>
      <Text> {current}/{total} ({percent}%)</Text>
    </Box>
  );
}

export function ProgressPanel({ job }: ProgressPanelProps): React.ReactElement {
  const stats = (job.stats ?? {}) as Record<string, number>;
  const status = String(job.status ?? 'unknown');
  const pagesFound = stats.pagesFound ?? 0;
  const pagesCrawled = stats.pagesCrawled ?? 0;
  const pagesExtracted = stats.pagesExtracted ?? 0;
  const pagesReconciled = stats.pagesReconciled ?? 0;
  const actionsPending = stats.actionsPending ?? 0;
  const actionsApplied = stats.actionsApplied ?? 0;

  const statusColor =
    status === 'running' ? 'green' :
    status === 'paused' ? 'yellow' :
    status === 'completed' ? 'cyan' :
    status === 'failed' ? 'red' : 'white';

  return (
    <Panel title="Progress">
      <Box flexDirection="column" gap={0}>
        <Text>
          <Text bold>Status: </Text>
          <Text color={statusColor}>{status}</Text>
        </Text>
        <Box marginTop={1} flexDirection="column">
          <ProgressBar label="Crawled" current={pagesCrawled} total={pagesFound} color="green" />
          <ProgressBar label="Extracted" current={pagesExtracted} total={pagesFound} color="cyan" />
          <ProgressBar label="Reconciled" current={pagesReconciled} total={pagesFound} color="magenta" />
        </Box>
        <Box marginTop={1}>
          <Text>
            <Text bold>Actions: </Text>
            <Text color="yellow">{actionsPending} pending</Text>
            <Text>{' | '}</Text>
            <Text color="green">{actionsApplied} applied</Text>
          </Text>
        </Box>
      </Box>
    </Panel>
  );
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/cli test -- tests/unit/components/dashboard/progress-panel.test.tsx`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add apps/cli/src/components/dashboard/ProgressPanel.tsx apps/cli/tests/unit/components/dashboard/progress-panel.test.tsx
git commit -m "feat(cli): add ProgressPanel component with ASCII progress bars"
```

---

## Task 5: SchemaPanel Component (Dashboard)

**Files:**

- Create: `apps/cli/src/components/dashboard/SchemaPanel.tsx`
- Test: `apps/cli/tests/unit/components/dashboard/schema-panel.test.tsx`

**Context:** Shows the current schema state for the running job: mode, field count, field list with types, categories (if any), and evolution status. This is different from the ConfigPanel in conversational mode — it reads from the API-fetched schema data, not the local config-building state.

**Step 1: Write the failing test**

Create `apps/cli/tests/unit/components/dashboard/schema-panel.test.tsx`:

```typescript
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { SchemaPanel } from '../../../../src/components/dashboard/SchemaPanel.js';

describe('SchemaPanel', () => {
  it('renders schema mode and field count', () => {
    const schema = {
      mode: 'hybrid',
      version: 3,
      definition: {
        fields: [
          { name: 'price', type: 'currency' },
          { name: 'title', type: 'string' },
          { name: 'brand', type: 'string' },
        ],
      },
    };
    const { lastFrame } = render(<SchemaPanel schema={schema} />);
    const frame = lastFrame()!;

    expect(frame).toContain('hybrid');
    expect(frame).toContain('3 fields');
    expect(frame).toContain('v3');
  });

  it('lists field names and types', () => {
    const schema = {
      mode: 'discovery',
      version: 1,
      definition: {
        fields: [
          { name: 'price', type: 'currency' },
          { name: 'title', type: 'string' },
        ],
      },
    };
    const { lastFrame } = render(<SchemaPanel schema={schema} />);
    const frame = lastFrame()!;

    expect(frame).toContain('price');
    expect(frame).toContain('currency');
    expect(frame).toContain('title');
    expect(frame).toContain('string');
  });

  it('shows categories when present', () => {
    const schema = {
      mode: 'hybrid',
      version: 2,
      definition: {
        fields: [],
        categories: ['Headphones', 'Amplifiers', 'DACs'],
      },
    };
    const { lastFrame } = render(<SchemaPanel schema={schema} />);
    const frame = lastFrame()!;

    expect(frame).toContain('Headphones');
    expect(frame).toContain('Amplifiers');
    expect(frame).toContain('DACs');
  });

  it('handles null schema gracefully', () => {
    const { lastFrame } = render(<SchemaPanel schema={null} />);
    const frame = lastFrame()!;

    expect(frame).toContain('No schema');
  });

  it('handles schema with no fields', () => {
    const schema = {
      mode: 'discovery',
      version: 1,
      definition: { fields: [] },
    };
    const { lastFrame } = render(<SchemaPanel schema={schema} />);
    const frame = lastFrame()!;

    expect(frame).toContain('0 fields');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/cli test -- tests/unit/components/dashboard/schema-panel.test.tsx`
Expected: FAIL — module not found.

**Step 3: Implement SchemaPanel**

Create `apps/cli/src/components/dashboard/SchemaPanel.tsx`:

```typescript
import React from 'react';
import { Box, Text } from 'ink';
import { Panel } from '../shared/Panel.js';

export interface SchemaPanelProps {
  schema: Record<string, unknown> | null;
}

export function SchemaPanel({ schema }: SchemaPanelProps): React.ReactElement {
  if (!schema) {
    return (
      <Panel title="Schema">
        <Text dimColor>No schema data yet</Text>
      </Panel>
    );
  }

  const mode = String(schema.mode ?? 'unknown');
  const version = Number(schema.version ?? 0);
  const definition = (schema.definition ?? {}) as Record<string, unknown>;
  const fields = (definition.fields ?? []) as Array<Record<string, unknown>>;
  const categories = (definition.categories ?? []) as string[];

  return (
    <Panel title="Schema">
      <Box flexDirection="column" gap={0}>
        <Text>
          <Text bold>Mode: </Text>
          <Text color="yellow">{mode}</Text>
          <Text dimColor>{' | '}</Text>
          <Text>{fields.length} fields</Text>
          <Text dimColor>{' | '}</Text>
          <Text dimColor>v{version}</Text>
        </Text>

        {fields.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {fields.slice(0, 10).map((field, i) => (
              <Text key={i}>
                {'  '}
                {String(field.name)}
                {' '}
                <Text dimColor>({String(field.type)})</Text>
                {field.required === true ? <Text color="red">{' *'}</Text> : null}
              </Text>
            ))}
            {fields.length > 10 && (
              <Text dimColor>  ... and {fields.length - 10} more</Text>
            )}
          </Box>
        )}

        {categories.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Categories:</Text>
            {categories.map((cat, i) => (
              <Text key={i} color="cyan">{'  ' + cat}</Text>
            ))}
          </Box>
        )}
      </Box>
    </Panel>
  );
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/cli test -- tests/unit/components/dashboard/schema-panel.test.tsx`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add apps/cli/src/components/dashboard/SchemaPanel.tsx apps/cli/tests/unit/components/dashboard/schema-panel.test.tsx
git commit -m "feat(cli): add SchemaPanel component for dashboard schema display"
```

---

## Task 6: ActivityFeed and EntityPreview Components

**Files:**

- Create: `apps/cli/src/components/dashboard/ActivityFeed.tsx`
- Create: `apps/cli/src/components/dashboard/EntityPreview.tsx`
- Test: `apps/cli/tests/unit/components/dashboard/activity-feed.test.tsx`
- Test: `apps/cli/tests/unit/components/dashboard/entity-preview.test.tsx`

**Context:** ActivityFeed shows a reverse-chronological list of recent pipeline actions (both pending and applied). EntityPreview shows a small sample table of reconciled entities. Both are read-only display panels for the dashboard.

**Step 1: Write the failing tests**

Create `apps/cli/tests/unit/components/dashboard/activity-feed.test.tsx`:

```typescript
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { ActivityFeed } from '../../../../src/components/dashboard/ActivityFeed.js';

describe('ActivityFeed', () => {
  it('renders recent actions in reverse order', () => {
    const actions = [
      { id: 'a1', type: 'add_field', status: 'applied', payload: { field: { name: 'price' } }, createdAt: '2026-03-13T14:30:00Z' },
      { id: 'a2', type: 'merge_fields', status: 'pending_review', payload: { canonicalName: 'brand' }, createdAt: '2026-03-13T14:35:00Z' },
      { id: 'a3', type: 'modify_field', status: 'applied', payload: { fieldName: 'title' }, createdAt: '2026-03-13T14:40:00Z' },
    ];
    const { lastFrame } = render(<ActivityFeed actions={actions} />);
    const frame = lastFrame()!;

    expect(frame).toContain('add_field');
    expect(frame).toContain('merge_fields');
    expect(frame).toContain('modify_field');
  });

  it('shows status indicator for each action', () => {
    const actions = [
      { id: 'a1', type: 'add_field', status: 'applied', payload: {}, createdAt: '2026-03-13T14:30:00Z' },
      { id: 'a2', type: 'merge_fields', status: 'pending_review', payload: {}, createdAt: '2026-03-13T14:35:00Z' },
    ];
    const { lastFrame } = render(<ActivityFeed actions={actions} />);
    const frame = lastFrame()!;

    // Applied actions get a checkmark, pending get a clock
    expect(frame).toMatch(/[✓✔]/); // applied indicator
    expect(frame).toMatch(/[⏳○]/); // pending indicator
  });

  it('shows empty message when no actions', () => {
    const { lastFrame } = render(<ActivityFeed actions={[]} />);
    expect(lastFrame()!).toContain('No activity');
  });

  it('limits display to most recent 8 actions', () => {
    const actions = Array.from({ length: 12 }, (_, i) => ({
      id: `a${i}`,
      type: 'add_field',
      status: 'applied',
      payload: { field: { name: `field_${i}` } },
      createdAt: `2026-03-13T14:${String(i).padStart(2, '0')}:00Z`,
    }));
    const { lastFrame } = render(<ActivityFeed actions={actions} />);
    const frame = lastFrame()!;

    // Should show latest 8, not all 12
    expect(frame).toContain('field_11');
    expect(frame).toContain('field_4');
    expect(frame).not.toContain('field_3');
  });
});
```

Create `apps/cli/tests/unit/components/dashboard/entity-preview.test.tsx`:

```typescript
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { EntityPreview } from '../../../../src/components/dashboard/EntityPreview.js';

describe('EntityPreview', () => {
  it('renders entity names', () => {
    const entities = [
      { id: 'e1', mergedData: { name: 'Sennheiser HD-650', price: 499 }, categories: ['Headphones'] },
      { id: 'e2', mergedData: { name: 'Topping A90', price: 599 }, categories: ['Amplifiers'] },
    ];
    const { lastFrame } = render(<EntityPreview entities={entities} />);
    const frame = lastFrame()!;

    expect(frame).toContain('HD-650');
    expect(frame).toContain('Topping A90');
  });

  it('shows categories', () => {
    const entities = [
      { id: 'e1', mergedData: { name: 'HD-650' }, categories: ['Headphones'] },
    ];
    const { lastFrame } = render(<EntityPreview entities={entities} />);
    expect(lastFrame()!).toContain('Headphones');
  });

  it('shows entity count', () => {
    const entities = [
      { id: 'e1', mergedData: { name: 'A' }, categories: [] },
      { id: 'e2', mergedData: { name: 'B' }, categories: [] },
      { id: 'e3', mergedData: { name: 'C' }, categories: [] },
    ];
    const { lastFrame } = render(<EntityPreview entities={entities} totalCount={150} />);
    expect(lastFrame()!).toContain('150');
  });

  it('shows empty message when no entities', () => {
    const { lastFrame } = render(<EntityPreview entities={[]} />);
    expect(lastFrame()!).toContain('No entities');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/cli test -- tests/unit/components/dashboard/activity-feed.test.tsx tests/unit/components/dashboard/entity-preview.test.tsx`
Expected: FAIL — modules not found.

**Step 3: Implement ActivityFeed**

Create `apps/cli/src/components/dashboard/ActivityFeed.tsx`:

```typescript
import React from 'react';
import { Box, Text } from 'ink';
import { Panel } from '../shared/Panel.js';

export interface ActivityFeedProps {
  actions: Record<string, unknown>[];
}

const MAX_ITEMS = 8;

function statusIndicator(status: string): { symbol: string; color: string } {
  switch (status) {
    case 'applied':
      return { symbol: '✓', color: 'green' };
    case 'approved':
      return { symbol: '✔', color: 'green' };
    case 'pending_review':
      return { symbol: '○', color: 'yellow' };
    case 'rejected':
      return { symbol: '✗', color: 'red' };
    default:
      return { symbol: '·', color: 'white' };
  }
}

function formatActionLabel(action: Record<string, unknown>): string {
  const type = String(action.type ?? 'unknown');
  const payload = (action.payload ?? {}) as Record<string, unknown>;

  // Try to extract a meaningful label from the payload
  if (payload.field && typeof payload.field === 'object') {
    const field = payload.field as Record<string, unknown>;
    return `${type}: ${String(field.name ?? '')}`;
  }
  if (payload.fieldName) return `${type}: ${String(payload.fieldName)}`;
  if (payload.canonicalName) return `${type}: ${String(payload.canonicalName)}`;
  return type;
}

export function ActivityFeed({ actions }: ActivityFeedProps): React.ReactElement {
  if (actions.length === 0) {
    return (
      <Panel title="Activity">
        <Text dimColor>No activity yet</Text>
      </Panel>
    );
  }

  // Sort by createdAt descending, take latest MAX_ITEMS
  const sorted = [...actions]
    .sort((a, b) => {
      const aTime = String(a.createdAt ?? '');
      const bTime = String(b.createdAt ?? '');
      return bTime.localeCompare(aTime);
    })
    .slice(0, MAX_ITEMS);

  return (
    <Panel title="Activity">
      <Box flexDirection="column">
        {sorted.map((action, i) => {
          const status = String(action.status ?? 'unknown');
          const { symbol, color } = statusIndicator(status);
          const label = formatActionLabel(action);

          return (
            <Box key={i} gap={1}>
              <Text color={color}>{symbol}</Text>
              <Text>{label}</Text>
            </Box>
          );
        })}
      </Box>
    </Panel>
  );
}
```

**Step 4: Implement EntityPreview**

Create `apps/cli/src/components/dashboard/EntityPreview.tsx`:

```typescript
import React from 'react';
import { Box, Text } from 'ink';
import { Panel } from '../shared/Panel.js';

export interface EntityPreviewProps {
  entities: Record<string, unknown>[];
  totalCount?: number;
}

export function EntityPreview({ entities, totalCount }: EntityPreviewProps): React.ReactElement {
  if (entities.length === 0) {
    return (
      <Panel title="Entities">
        <Text dimColor>No entities yet</Text>
      </Panel>
    );
  }

  const countLabel = totalCount !== undefined
    ? `Entities (${entities.length} of ${totalCount})`
    : `Entities (${entities.length})`;

  return (
    <Panel title={countLabel}>
      <Box flexDirection="column">
        {entities.map((entity, i) => {
          const mergedData = (entity.mergedData ?? {}) as Record<string, unknown>;
          const name = String(mergedData.name ?? mergedData.title ?? `Entity ${i + 1}`);
          const categories = (entity.categories ?? []) as string[];
          const fieldCount = Object.keys(mergedData).length;

          return (
            <Box key={i} gap={1}>
              <Text bold>{name}</Text>
              {categories.length > 0 && (
                <Text dimColor>[{categories.join(', ')}]</Text>
              )}
              <Text dimColor>({fieldCount} fields)</Text>
            </Box>
          );
        })}
      </Box>
    </Panel>
  );
}
```

**Step 5: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/cli test -- tests/unit/components/dashboard/activity-feed.test.tsx tests/unit/components/dashboard/entity-preview.test.tsx`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add apps/cli/src/components/dashboard/ActivityFeed.tsx apps/cli/src/components/dashboard/EntityPreview.tsx apps/cli/tests/unit/components/dashboard/activity-feed.test.tsx apps/cli/tests/unit/components/dashboard/entity-preview.test.tsx
git commit -m "feat(cli): add ActivityFeed and EntityPreview dashboard components"
```

---

## Task 7: DashboardView Composition + Barrel Export

**Files:**

- Create: `apps/cli/src/components/dashboard/DashboardView.tsx`
- Create: `apps/cli/src/components/dashboard/index.ts`
- Test: `apps/cli/tests/unit/components/dashboard/dashboard-view.test.tsx`

**Context:** DashboardView is the top-level component for dashboard mode. It composes ProgressPanel, SchemaPanel, ActivityFeed, and EntityPreview into a 2x2 grid layout. It uses `useStore` to read job runtime state from the store, and `useKeyboard` for dashboard-specific hotkeys (space to pause/resume, C to cancel). It also renders the loading/error state when polling is in progress or has failed.

**Step 1: Write the failing test**

Create `apps/cli/tests/unit/components/dashboard/dashboard-view.test.tsx`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { DashboardView } from '../../../../src/components/dashboard/DashboardView.js';
import { createCliStore } from '../../../../src/store/index.js';
import type { SpatulaApiClient } from '../../../../src/api/client.js';

function createMockApiClient(): SpatulaApiClient {
  return {
    getJob: vi.fn().mockResolvedValue({
      id: 'job-1',
      name: 'Test Job',
      status: 'running',
      stats: {
        pagesFound: 100,
        pagesCrawled: 60,
        pagesExtracted: 40,
        pagesReconciled: 20,
        actionsPending: 3,
        actionsApplied: 12,
      },
    }),
    listActions: vi.fn().mockResolvedValue([]),
    getSchema: vi.fn().mockResolvedValue({ mode: 'hybrid', version: 2, definition: { fields: [] } }),
    listEntities: vi.fn().mockResolvedValue([]),
    pauseJob: vi.fn().mockResolvedValue({}),
    resumeJob: vi.fn().mockResolvedValue({}),
    cancelJob: vi.fn().mockResolvedValue({}),
  } as unknown as SpatulaApiClient;
}

describe('DashboardView', () => {
  it('renders all four panels', async () => {
    const store = createCliStore('test-tenant');
    store.getState().setActiveJobId('job-1');
    store.getState().setJobData({
      id: 'job-1',
      name: 'Test Job',
      status: 'running',
      stats: { pagesFound: 100, pagesCrawled: 60, pagesExtracted: 40, pagesReconciled: 20, actionsPending: 3, actionsApplied: 12 },
    });

    const apiClient = createMockApiClient();
    const { lastFrame } = render(
      <DashboardView store={store} apiClient={apiClient} />,
    );
    const frame = lastFrame()!;

    expect(frame).toContain('Progress');
    expect(frame).toContain('Schema');
    expect(frame).toContain('Activity');
    expect(frame).toContain('Entities');
  });

  it('shows job name in header area', () => {
    const store = createCliStore('test-tenant');
    store.getState().setActiveJobId('job-1');
    store.getState().setJobData({
      id: 'job-1',
      name: 'My Crawl Job',
      status: 'running',
      stats: { pagesFound: 10, pagesCrawled: 5, pagesExtracted: 0, pagesReconciled: 0, actionsPending: 0, actionsApplied: 0 },
    });

    const apiClient = createMockApiClient();
    const { lastFrame } = render(
      <DashboardView store={store} apiClient={apiClient} />,
    );
    expect(lastFrame()!).toContain('My Crawl Job');
  });

  it('shows waiting message when no job data', () => {
    const store = createCliStore('test-tenant');
    store.getState().setActiveJobId('job-1');

    const apiClient = createMockApiClient();
    const { lastFrame } = render(
      <DashboardView store={store} apiClient={apiClient} />,
    );
    expect(lastFrame()!).toContain('Loading');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/cli test -- tests/unit/components/dashboard/dashboard-view.test.tsx`
Expected: FAIL — module not found.

**Step 3: Implement DashboardView**

Create `apps/cli/src/components/dashboard/DashboardView.tsx`:

```typescript
import React from 'react';
import { Box, Text } from 'ink';
import { useStore } from 'zustand';
import type { CliStore } from '../../store/index.js';
import type { SpatulaApiClient } from '../../api/client.js';
import { useJobPolling } from '../../hooks/useJobPolling.js';
import { useKeyboard } from '../../hooks/useKeyboard.js';
import { Spinner } from '../shared/Spinner.js';
import { ProgressPanel } from './ProgressPanel.js';
import { SchemaPanel } from './SchemaPanel.js';
import { ActivityFeed } from './ActivityFeed.js';
import { EntityPreview } from './EntityPreview.js';

export interface DashboardViewProps {
  store: CliStore;
  apiClient: SpatulaApiClient;
}

export function DashboardView({
  store,
  apiClient,
}: DashboardViewProps): React.ReactElement {
  const activeJobId = useStore(store, (s) => s.activeJobId);
  const jobData = useStore(store, (s) => s.jobData);
  const pendingActions = useStore(store, (s) => s.pendingActions);
  const schemaData = useStore(store, (s) => s.schemaData);
  const entityPreviews = useStore(store, (s) => s.entityPreviews);

  const { lastError } = useJobPolling(
    store,
    apiClient,
    activeJobId ?? '',
    3000,
  );

  useKeyboard({
    space: async () => {
      if (!activeJobId || !jobData) return;
      const status = String(jobData.status ?? '');
      if (status === 'running') {
        await apiClient.pauseJob(activeJobId);
      } else if (status === 'paused') {
        await apiClient.resumeJob(activeJobId);
      }
    },
    c: async () => {
      if (!activeJobId) return;
      await apiClient.cancelJob(activeJobId);
    },
  });

  if (!activeJobId) {
    return <Text dimColor>No active job. Start a job in conversational mode first.</Text>;
  }

  if (!jobData) {
    return <Spinner label="Loading job data..." />;
  }

  const jobName = String(jobData.name ?? 'Untitled Job');

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Job title bar */}
      <Box gap={1}>
        <Text bold>{jobName}</Text>
        <Text dimColor>({activeJobId.slice(0, 8)})</Text>
        {lastError && <Text color="red"> Error: {lastError}</Text>}
      </Box>

      {/* 2x2 grid layout */}
      <Box flexGrow={1}>
        {/* Left column */}
        <Box flexDirection="column" flexGrow={1}>
          <ProgressPanel job={jobData} />
          <ActivityFeed actions={pendingActions} />
        </Box>

        {/* Right column */}
        <Box flexDirection="column" width={40}>
          <SchemaPanel schema={schemaData} />
          <EntityPreview entities={entityPreviews} />
        </Box>
      </Box>
    </Box>
  );
}
```

Create `apps/cli/src/components/dashboard/index.ts`:

```typescript
export { DashboardView } from './DashboardView.js';
export type { DashboardViewProps } from './DashboardView.js';
export { ProgressPanel } from './ProgressPanel.js';
export { SchemaPanel } from './SchemaPanel.js';
export { ActivityFeed } from './ActivityFeed.js';
export { EntityPreview } from './EntityPreview.js';
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/cli test -- tests/unit/components/dashboard/dashboard-view.test.tsx`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add apps/cli/src/components/dashboard/ apps/cli/tests/unit/components/dashboard/dashboard-view.test.tsx
git commit -m "feat(cli): add DashboardView with 2x2 panel layout and job polling"
```

---

## Task 8: ActionCard and DiffPreview Components

**Files:**

- Create: `apps/cli/src/components/review/ActionCard.tsx`
- Create: `apps/cli/src/components/review/DiffPreview.tsx`
- Test: `apps/cli/tests/unit/components/review/action-card.test.tsx`
- Test: `apps/cli/tests/unit/components/review/diff-preview.test.tsx`

**Context:** ActionCard is the primary display for a single pending pipeline action in Review mode. It shows the action type, confidence score, reasoning, payload summary, and source. DiffPreview shows a visual before→after comparison of what the action would change. These are the building blocks for ReviewView.

**Step 1: Write the failing tests**

Create `apps/cli/tests/unit/components/review/action-card.test.tsx`:

```typescript
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { ActionCard } from '../../../../src/components/review/ActionCard.js';

describe('ActionCard', () => {
  it('renders action type and confidence', () => {
    const action = {
      id: 'a1',
      type: 'add_field',
      confidence: 0.92,
      reasoning: 'Detected in 45% of product pages',
      source: 'schema_evolution',
      payload: {
        field: { name: 'price_currency', type: 'string', description: 'Currency code' },
      },
    };
    const { lastFrame } = render(
      <ActionCard action={action} index={0} total={5} />,
    );
    const frame = lastFrame()!;

    expect(frame).toContain('add_field');
    expect(frame).toContain('92%');
    expect(frame).toContain('1 of 5');
  });

  it('shows reasoning text', () => {
    const action = {
      id: 'a1',
      type: 'merge_fields',
      confidence: 0.85,
      reasoning: 'Fields "cost" and "price" appear to be synonyms',
      source: 'schema_evolution',
      payload: { canonicalName: 'price', aliasNames: ['cost'] },
    };
    const { lastFrame } = render(
      <ActionCard action={action} index={0} total={1} />,
    );
    expect(lastFrame()!).toContain('synonyms');
  });

  it('shows source label', () => {
    const action = {
      id: 'a1',
      type: 'add_field',
      confidence: 0.7,
      reasoning: 'Found during reconciliation',
      source: 'reconciliation',
      payload: { field: { name: 'brand', type: 'string', description: '' } },
    };
    const { lastFrame } = render(
      <ActionCard action={action} index={0} total={1} />,
    );
    expect(lastFrame()!).toContain('reconciliation');
  });

  it('shows payload summary for add_field', () => {
    const action = {
      id: 'a1',
      type: 'add_field',
      confidence: 0.9,
      reasoning: 'Common field',
      source: 'schema_evolution',
      payload: {
        field: { name: 'brand', type: 'string', description: 'Product brand name', required: false },
      },
    };
    const { lastFrame } = render(
      <ActionCard action={action} index={0} total={1} />,
    );
    const frame = lastFrame()!;

    expect(frame).toContain('brand');
    expect(frame).toContain('string');
  });

  it('shows payload summary for merge_fields', () => {
    const action = {
      id: 'a1',
      type: 'merge_fields',
      confidence: 0.88,
      reasoning: 'Synonyms',
      source: 'schema_evolution',
      payload: { canonicalName: 'price', aliasNames: ['cost', 'retail_price'] },
    };
    const { lastFrame } = render(
      <ActionCard action={action} index={0} total={1} />,
    );
    const frame = lastFrame()!;

    expect(frame).toContain('price');
    expect(frame).toContain('cost');
    expect(frame).toContain('retail_price');
  });

  it('color-codes confidence level', () => {
    // High confidence = green
    const high = {
      id: 'a1', type: 'add_field', confidence: 0.95,
      reasoning: '', source: 'schema_evolution',
      payload: { field: { name: 'x', type: 'string', description: '' } },
    };
    const { lastFrame: highFrame } = render(
      <ActionCard action={high} index={0} total={1} />,
    );
    // We can't check colors directly in ink-testing-library,
    // but we can check the percentage renders
    expect(highFrame()!).toContain('95%');
  });

  it('shows risk level label', () => {
    const low = {
      id: 'a1', type: 'add_field', confidence: 0.95,
      reasoning: '', source: 'schema_evolution',
      payload: { field: { name: 'x', type: 'string', description: '' } },
    };
    const { lastFrame } = render(
      <ActionCard action={low} index={0} total={1} />,
    );
    expect(lastFrame()!).toContain('LOW');
  });
});
```

Create `apps/cli/tests/unit/components/review/diff-preview.test.tsx`:

```typescript
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { DiffPreview } from '../../../../src/components/review/DiffPreview.js';

describe('DiffPreview', () => {
  it('shows added fields for add_field action', () => {
    const action = {
      type: 'add_field',
      payload: {
        field: { name: 'price_currency', type: 'string', description: 'Currency' },
      },
    };
    const { lastFrame } = render(<DiffPreview action={action} />);
    const frame = lastFrame()!;

    expect(frame).toContain('+');
    expect(frame).toContain('price_currency');
  });

  it('shows merge info for merge_fields action', () => {
    const action = {
      type: 'merge_fields',
      payload: {
        canonicalName: 'price',
        aliasNames: ['cost', 'retail_price'],
      },
    };
    const { lastFrame } = render(<DiffPreview action={action} />);
    const frame = lastFrame()!;

    expect(frame).toContain('cost');
    expect(frame).toContain('retail_price');
    expect(frame).toContain('price');
  });

  it('shows removed field for remove_field action', () => {
    const action = {
      type: 'remove_field',
      payload: {
        fieldName: 'obsolete_field',
        reason: 'too_rare',
      },
    };
    const { lastFrame } = render(<DiffPreview action={action} />);
    const frame = lastFrame()!;

    expect(frame).toContain('-');
    expect(frame).toContain('obsolete_field');
    expect(frame).toContain('too_rare');
  });

  it('shows field changes for modify_field action', () => {
    const action = {
      type: 'modify_field',
      payload: {
        fieldName: 'price',
        changes: { type: 'currency', required: true },
      },
    };
    const { lastFrame } = render(<DiffPreview action={action} />);
    const frame = lastFrame()!;

    expect(frame).toContain('price');
    expect(frame).toContain('currency');
  });

  it('shows generic payload for unknown action types', () => {
    const action = {
      type: 'set_source_trust',
      payload: { rankings: [{ domain: 'amazon.com', trustLevel: 'high' }] },
    };
    const { lastFrame } = render(<DiffPreview action={action} />);
    const frame = lastFrame()!;

    expect(frame).toContain('set_source_trust');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/cli test -- tests/unit/components/review/action-card.test.tsx tests/unit/components/review/diff-preview.test.tsx`
Expected: FAIL — modules not found.

**Step 3: Implement ActionCard**

Create `apps/cli/src/components/review/ActionCard.tsx`:

```typescript
import React from 'react';
import { Box, Text } from 'ink';
import { Panel } from '../shared/Panel.js';

export interface ActionCardProps {
  action: Record<string, unknown>;
  index: number;
  total: number;
}

function riskLevel(confidence: number): { label: string; color: string } {
  if (confidence >= 0.85) return { label: 'LOW', color: 'green' };
  if (confidence >= 0.6) return { label: 'MEDIUM', color: 'yellow' };
  return { label: 'HIGH', color: 'red' };
}

function confidenceColor(confidence: number): string {
  if (confidence >= 0.85) return 'green';
  if (confidence >= 0.6) return 'yellow';
  return 'red';
}

function PayloadSummary({ action }: { action: Record<string, unknown> }): React.ReactElement {
  const type = String(action.type);
  const payload = (action.payload ?? {}) as Record<string, unknown>;

  switch (type) {
    case 'add_field': {
      const field = (payload.field ?? {}) as Record<string, unknown>;
      return (
        <Box flexDirection="column">
          <Text>
            <Text bold>Field: </Text>
            <Text>{String(field.name)}</Text>
            <Text dimColor> ({String(field.type)})</Text>
            {field.required === true && <Text color="red"> required</Text>}
          </Text>
          {field.description && (
            <Text dimColor>  {String(field.description)}</Text>
          )}
        </Box>
      );
    }

    case 'merge_fields': {
      const canonical = String(payload.canonicalName ?? '');
      const aliases = (payload.aliasNames ?? []) as string[];
      return (
        <Box flexDirection="column">
          <Text>
            <Text bold>Merge: </Text>
            <Text>{aliases.join(', ')}</Text>
            <Text dimColor>{' → '}</Text>
            <Text color="green">{canonical}</Text>
          </Text>
        </Box>
      );
    }

    case 'remove_field': {
      return (
        <Text>
          <Text bold>Remove: </Text>
          <Text color="red">{String(payload.fieldName)}</Text>
          <Text dimColor> ({String(payload.reason)})</Text>
        </Text>
      );
    }

    case 'modify_field': {
      const changes = (payload.changes ?? {}) as Record<string, unknown>;
      const changeList = Object.entries(changes)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(', ');
      return (
        <Text>
          <Text bold>Modify: </Text>
          <Text>{String(payload.fieldName)}</Text>
          <Text dimColor> ({changeList})</Text>
        </Text>
      );
    }

    case 'resolve_conflict': {
      return (
        <Text>
          <Text bold>Resolve: </Text>
          <Text>{String(payload.fieldName)}</Text>
          <Text dimColor>{' → '}</Text>
          <Text>{String(payload.resolvedValue)}</Text>
        </Text>
      );
    }

    default: {
      // Generic summary for other action types
      const keys = Object.keys(payload).slice(0, 3);
      return (
        <Text dimColor>
          {type}: {keys.join(', ')}
        </Text>
      );
    }
  }
}

export function ActionCard({
  action,
  index,
  total,
}: ActionCardProps): React.ReactElement {
  const type = String(action.type ?? 'unknown');
  const confidence = Number(action.confidence ?? 0);
  const reasoning = String(action.reasoning ?? '');
  const source = String(action.source ?? 'unknown');
  const risk = riskLevel(confidence);
  const pct = Math.round(confidence * 100);

  return (
    <Panel title={type} borderColor={risk.color}>
      <Box flexDirection="column" gap={0}>
        {/* Header: index, confidence, risk */}
        <Box gap={2}>
          <Text dimColor>{index + 1} of {total}</Text>
          <Text>
            <Text bold>Confidence: </Text>
            <Text color={confidenceColor(confidence)}>{pct}%</Text>
          </Text>
          <Text>
            <Text bold>Risk: </Text>
            <Text color={risk.color}>{risk.label}</Text>
          </Text>
        </Box>

        {/* Source */}
        <Text>
          <Text bold>Source: </Text>
          <Text>{source}</Text>
        </Text>

        {/* Reasoning */}
        <Box marginTop={1}>
          <Text>
            <Text bold>Reasoning: </Text>
            <Text>{reasoning}</Text>
          </Text>
        </Box>

        {/* Payload summary */}
        <Box marginTop={1}>
          <PayloadSummary action={action} />
        </Box>
      </Box>
    </Panel>
  );
}
```

**Step 4: Implement DiffPreview**

Create `apps/cli/src/components/review/DiffPreview.tsx`:

```typescript
import React from 'react';
import { Box, Text } from 'ink';
import { Panel } from '../shared/Panel.js';

export interface DiffPreviewProps {
  action: Record<string, unknown>;
}

export function DiffPreview({ action }: DiffPreviewProps): React.ReactElement {
  const type = String(action.type ?? 'unknown');
  const payload = (action.payload ?? {}) as Record<string, unknown>;

  return (
    <Panel title="Impact Preview">
      <Box flexDirection="column">
        <DiffContent type={type} payload={payload} />
      </Box>
    </Panel>
  );
}

function DiffContent({
  type,
  payload,
}: {
  type: string;
  payload: Record<string, unknown>;
}): React.ReactElement {
  switch (type) {
    case 'add_field': {
      const field = (payload.field ?? {}) as Record<string, unknown>;
      return (
        <Box flexDirection="column">
          <Text color="green">+ {String(field.name)}: {String(field.type)}</Text>
          {field.description && (
            <Text dimColor>  {String(field.description)}</Text>
          )}
        </Box>
      );
    }

    case 'merge_fields': {
      const canonical = String(payload.canonicalName ?? '');
      const aliases = (payload.aliasNames ?? []) as string[];
      return (
        <Box flexDirection="column">
          {aliases.map((alias, i) => (
            <Text key={i} color="red">- {alias}</Text>
          ))}
          <Text color="green">+ {canonical} (merged)</Text>
        </Box>
      );
    }

    case 'remove_field': {
      return (
        <Box flexDirection="column">
          <Text color="red">- {String(payload.fieldName)}</Text>
          <Text dimColor>  Reason: {String(payload.reason)}</Text>
        </Box>
      );
    }

    case 'modify_field': {
      const changes = (payload.changes ?? {}) as Record<string, unknown>;
      return (
        <Box flexDirection="column">
          <Text color="yellow">~ {String(payload.fieldName)}</Text>
          {Object.entries(changes).map(([key, value], i) => (
            <Text key={i}>
              {'  '}
              <Text dimColor>{key}: </Text>
              <Text color="green">{String(value)}</Text>
            </Text>
          ))}
        </Box>
      );
    }

    case 'rename_field': {
      return (
        <Box flexDirection="column">
          <Text color="red">- {String(payload.currentName)}</Text>
          <Text color="green">+ {String(payload.newName)}</Text>
        </Box>
      );
    }

    case 'resolve_conflict': {
      const allValues = (payload.allValues ?? []) as Array<Record<string, unknown>>;
      return (
        <Box flexDirection="column">
          <Text bold>{String(payload.fieldName)}</Text>
          {allValues.map((v, i) => (
            <Text key={i} dimColor>
              {'  '}{String(v.source)}: {String(v.value)}
            </Text>
          ))}
          <Text color="green">{'  → '}{String(payload.resolvedValue)} (from {String(payload.sourcePreferred)})</Text>
        </Box>
      );
    }

    default: {
      return (
        <Text dimColor>{type}: {JSON.stringify(payload).slice(0, 80)}</Text>
      );
    }
  }
}
```

**Step 5: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/cli test -- tests/unit/components/review/action-card.test.tsx tests/unit/components/review/diff-preview.test.tsx`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add apps/cli/src/components/review/ActionCard.tsx apps/cli/src/components/review/DiffPreview.tsx apps/cli/tests/unit/components/review/action-card.test.tsx apps/cli/tests/unit/components/review/diff-preview.test.tsx
git commit -m "feat(cli): add ActionCard and DiffPreview review mode components"
```

---

## Task 9: ReviewView Composition + Barrel Export

**Files:**

- Create: `apps/cli/src/components/review/ReviewView.tsx`
- Create: `apps/cli/src/components/review/index.ts`
- Test: `apps/cli/tests/unit/components/review/review-view.test.tsx`

**Context:** ReviewView is the top-level component for review mode. It shows one pending action at a time with ActionCard + DiffPreview, and handles keyboard navigation: up/down to move between actions, Y to approve, N to reject, A to approve all. It fetches pending actions from the store and calls the API client to approve/reject.

**Step 1: Write the failing test**

Create `apps/cli/tests/unit/components/review/review-view.test.tsx`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { ReviewView } from '../../../../src/components/review/ReviewView.js';
import { createCliStore } from '../../../../src/store/index.js';
import type { SpatulaApiClient } from '../../../../src/api/client.js';

function createMockApiClient(): SpatulaApiClient {
  return {
    getJob: vi.fn().mockResolvedValue({ id: 'job-1', status: 'running', stats: {} }),
    listActions: vi.fn().mockResolvedValue([]),
    getSchema: vi.fn().mockResolvedValue(null),
    listEntities: vi.fn().mockResolvedValue([]),
    approveAction: vi.fn().mockResolvedValue({}),
    rejectAction: vi.fn().mockResolvedValue({}),
    approveAllActions: vi.fn().mockResolvedValue([]),
  } as unknown as SpatulaApiClient;
}

const sampleActions = [
  {
    id: 'a1',
    type: 'add_field',
    confidence: 0.92,
    reasoning: 'Common field detected',
    source: 'schema_evolution',
    payload: { field: { name: 'brand', type: 'string', description: 'Brand name' } },
    status: 'pending_review',
  },
  {
    id: 'a2',
    type: 'merge_fields',
    confidence: 0.85,
    reasoning: 'Synonyms detected',
    source: 'schema_evolution',
    payload: { canonicalName: 'price', aliasNames: ['cost'] },
    status: 'pending_review',
  },
  {
    id: 'a3',
    type: 'remove_field',
    confidence: 0.7,
    reasoning: 'Too rare to be useful',
    source: 'schema_evolution',
    payload: { fieldName: 'old_field', reason: 'too_rare' },
    status: 'pending_review',
  },
];

describe('ReviewView', () => {
  it('renders the first action by default', () => {
    const store = createCliStore('test-tenant');
    store.getState().setActiveJobId('job-1');
    store.getState().setPendingActions(sampleActions);

    const apiClient = createMockApiClient();
    const { lastFrame } = render(
      <ReviewView store={store} apiClient={apiClient} />,
    );
    const frame = lastFrame()!;

    expect(frame).toContain('add_field');
    expect(frame).toContain('1 of 3');
    expect(frame).toContain('brand');
  });

  it('shows empty state when no pending actions', () => {
    const store = createCliStore('test-tenant');
    store.getState().setActiveJobId('job-1');
    store.getState().setPendingActions([]);

    const apiClient = createMockApiClient();
    const { lastFrame } = render(
      <ReviewView store={store} apiClient={apiClient} />,
    );
    expect(lastFrame()!).toContain('No pending actions');
  });

  it('navigates to next action on down arrow', () => {
    const store = createCliStore('test-tenant');
    store.getState().setActiveJobId('job-1');
    store.getState().setPendingActions(sampleActions);

    const apiClient = createMockApiClient();
    const { lastFrame, stdin } = render(
      <ReviewView store={store} apiClient={apiClient} />,
    );

    // Navigate down
    stdin.write('\u001B[B'); // down arrow
    const frame = lastFrame()!;

    expect(frame).toContain('merge_fields');
    expect(frame).toContain('2 of 3');
  });

  it('navigates back on up arrow', () => {
    const store = createCliStore('test-tenant');
    store.getState().setActiveJobId('job-1');
    store.getState().setPendingActions(sampleActions);
    store.getState().setReviewIndex(1);

    const apiClient = createMockApiClient();
    const { lastFrame, stdin } = render(
      <ReviewView store={store} apiClient={apiClient} />,
    );

    stdin.write('\u001B[A'); // up arrow
    expect(lastFrame()!).toContain('1 of 3');
  });

  it('shows keyboard hints for review actions', () => {
    const store = createCliStore('test-tenant');
    store.getState().setActiveJobId('job-1');
    store.getState().setPendingActions(sampleActions);

    const apiClient = createMockApiClient();
    const { lastFrame } = render(
      <ReviewView store={store} apiClient={apiClient} />,
    );
    const frame = lastFrame()!;

    expect(frame).toContain('Y');
    expect(frame).toContain('Approve');
    expect(frame).toContain('N');
    expect(frame).toContain('Reject');
  });

  it('shows DiffPreview below ActionCard', () => {
    const store = createCliStore('test-tenant');
    store.getState().setActiveJobId('job-1');
    store.getState().setPendingActions(sampleActions);

    const apiClient = createMockApiClient();
    const { lastFrame } = render(
      <ReviewView store={store} apiClient={apiClient} />,
    );
    expect(lastFrame()!).toContain('Impact Preview');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/cli test -- tests/unit/components/review/review-view.test.tsx`
Expected: FAIL — module not found.

**Step 3: Implement ReviewView**

Create `apps/cli/src/components/review/ReviewView.tsx`:

```typescript
import React, { useCallback } from 'react';
import { Box, Text } from 'ink';
import { useStore } from 'zustand';
import type { CliStore } from '../../store/index.js';
import type { SpatulaApiClient } from '../../api/client.js';
import { useJobPolling } from '../../hooks/useJobPolling.js';
import { useKeyboard } from '../../hooks/useKeyboard.js';
import { KeyboardHints } from '../shared/KeyboardHints.js';
import { ActionCard } from './ActionCard.js';
import { DiffPreview } from './DiffPreview.js';

export interface ReviewViewProps {
  store: CliStore;
  apiClient: SpatulaApiClient;
}

const reviewHints = [
  { key: 'Y', description: 'Approve' },
  { key: 'N', description: 'Reject' },
  { key: '↑/↓', description: 'Navigate' },
  { key: 'A', description: 'Approve all' },
];

export function ReviewView({
  store,
  apiClient,
}: ReviewViewProps): React.ReactElement {
  const activeJobId = useStore(store, (s) => s.activeJobId);
  const pendingActions = useStore(store, (s) => s.pendingActions);
  const reviewIndex = useStore(store, (s) => s.reviewIndex);

  useJobPolling(store, apiClient, activeJobId ?? '', 5000);

  const currentAction = pendingActions[reviewIndex] ?? null;

  const approve = useCallback(async () => {
    if (!activeJobId || !currentAction) return;
    const actionId = String((currentAction as Record<string, unknown>).id);
    await apiClient.approveAction(activeJobId, actionId);
    store.getState().removeAction(actionId);
    // Adjust index if we removed the last item
    const remaining = store.getState().pendingActions.length;
    if (reviewIndex >= remaining && remaining > 0) {
      store.getState().setReviewIndex(remaining - 1);
    }
  }, [activeJobId, currentAction, apiClient, store, reviewIndex]);

  const reject = useCallback(async () => {
    if (!activeJobId || !currentAction) return;
    const actionId = String((currentAction as Record<string, unknown>).id);
    await apiClient.rejectAction(activeJobId, actionId);
    store.getState().removeAction(actionId);
    const remaining = store.getState().pendingActions.length;
    if (reviewIndex >= remaining && remaining > 0) {
      store.getState().setReviewIndex(remaining - 1);
    }
  }, [activeJobId, currentAction, apiClient, store, reviewIndex]);

  const approveAll = useCallback(async () => {
    if (!activeJobId) return;
    await apiClient.approveAllActions(activeJobId);
    store.getState().setPendingActions([]);
    store.getState().setReviewIndex(0);
  }, [activeJobId, apiClient, store]);

  useKeyboard({
    y: approve,
    Y: approve,
    n: reject,
    N: reject,
    a: approveAll,
    A: approveAll,
    upArrow: () => {
      store.getState().setReviewIndex(reviewIndex - 1);
    },
    downArrow: () => {
      const maxIndex = Math.max(0, pendingActions.length - 1);
      store.getState().setReviewIndex(Math.min(reviewIndex + 1, maxIndex));
    },
  });

  if (!activeJobId) {
    return <Text dimColor>No active job. Start a job first.</Text>;
  }

  if (pendingActions.length === 0) {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Text color="green" bold>No pending actions to review.</Text>
        <Text dimColor>New actions will appear here as the crawl progresses.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Action card */}
      <ActionCard
        action={currentAction as Record<string, unknown>}
        index={reviewIndex}
        total={pendingActions.length}
      />

      {/* Diff preview */}
      <DiffPreview action={currentAction as Record<string, unknown>} />

      {/* Hints */}
      <Box marginTop={1}>
        <KeyboardHints hints={reviewHints} />
      </Box>
    </Box>
  );
}
```

Create `apps/cli/src/components/review/index.ts`:

```typescript
export { ReviewView } from './ReviewView.js';
export type { ReviewViewProps } from './ReviewView.js';
export { ActionCard } from './ActionCard.js';
export { DiffPreview } from './DiffPreview.js';
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/cli test -- tests/unit/components/review/review-view.test.tsx`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add apps/cli/src/components/review/ apps/cli/tests/unit/components/review/review-view.test.tsx
git commit -m "feat(cli): add ReviewView with keyboard navigation and approve/reject flow"
```

---

## Task 10: App.tsx Mode Routing + CLI Command Integration

**Files:**

- Modify: `apps/cli/src/components/App.tsx`
- Modify: `apps/cli/src/commands/new.tsx`
- Modify: `apps/cli/tests/unit/components/app.test.tsx`

**Context:** Replace the dashboard/review stubs in App.tsx with the real components. The App needs to accept an `apiClient` prop (in addition to `store`) so DashboardView and ReviewView can call the API. Update the `new` command to pass the API client through. Add mode-switching keyboard hints and global hotkeys for D (dashboard), R (review). Update existing App tests and add new ones for the real routing.

**Step 1: Write the failing tests**

Update `apps/cli/tests/unit/components/app.test.tsx` — add new test cases:

```typescript
// Add to existing tests:

  it('renders DashboardView when mode is dashboard and job is active', () => {
    const store = createCliStore('test-tenant');
    store.getState().setMode('dashboard');
    store.getState().setActiveJobId('job-1');
    store.getState().setJobData({
      id: 'job-1',
      name: 'Test Job',
      status: 'running',
      stats: { pagesFound: 10, pagesCrawled: 5, pagesExtracted: 0, pagesReconciled: 0, actionsPending: 0, actionsApplied: 0 },
    });

    const apiClient = createMockApiClient();
    const { lastFrame } = render(
      <App store={store} apiClient={apiClient} onStartJob={noop} onExit={noop} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('Progress');
  });

  it('renders ReviewView when mode is review and job is active', () => {
    const store = createCliStore('test-tenant');
    store.getState().setMode('review');
    store.getState().setActiveJobId('job-1');
    store.getState().setPendingActions([
      { id: 'a1', type: 'add_field', confidence: 0.9, reasoning: 'test', source: 'schema_evolution', payload: { field: { name: 'x', type: 'string', description: '' } }, status: 'pending_review' },
    ]);

    const apiClient = createMockApiClient();
    const { lastFrame } = render(
      <App store={store} apiClient={apiClient} onStartJob={noop} onExit={noop} />,
    );
    expect(lastFrame()!).toContain('add_field');
  });

  it('shows context-appropriate keyboard hints per mode', () => {
    const store = createCliStore('test-tenant');
    store.getState().setMode('conversational');

    const apiClient = createMockApiClient();
    const { lastFrame } = render(
      <App store={store} apiClient={apiClient} onStartJob={noop} onExit={noop} />,
    );
    const frame = lastFrame()!;

    // Should show mode switching hints
    expect(frame).toContain('Ctrl+C');
  });
```

**Note:** The test file will need the mock API client helper added at the top (same pattern as other tests).

**Step 2: Run tests to verify they fail**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/cli test -- tests/unit/components/app.test.tsx`
Expected: FAIL — App component doesn't accept `apiClient` prop yet.

**Step 3: Update App.tsx**

Replace `apps/cli/src/components/App.tsx` with:

```typescript
import React from 'react';
import { Box, Text } from 'ink';
import { useStore } from 'zustand';
import type { CliStore } from '../store/index.js';
import type { SpatulaApiClient } from '../api/client.js';
import { Header, KeyboardHints } from './shared/index.js';
import { ConversationalView } from './conversational/ConversationalView.js';
import { DashboardView } from './dashboard/DashboardView.js';
import { ReviewView } from './review/ReviewView.js';
import type { KeyHint } from './shared/index.js';

export interface AppProps {
  store: CliStore;
  apiClient: SpatulaApiClient;
  onStartJob: (config: Record<string, unknown>) => void;
  onExit: () => void;
}

const conversationalHints: KeyHint[] = [
  { key: 'Enter', description: 'Send' },
  { key: 'D', description: 'Dashboard' },
  { key: 'R', description: 'Review' },
  { key: 'Ctrl+C', description: 'Quit' },
];

const dashboardHints: KeyHint[] = [
  { key: 'Space', description: 'Pause/Resume' },
  { key: 'C', description: 'Cancel job' },
  { key: 'R', description: 'Review' },
  { key: 'Ctrl+C', description: 'Quit' },
];

const reviewHints: KeyHint[] = [
  { key: 'Y/N', description: 'Approve/Reject' },
  { key: '↑/↓', description: 'Navigate' },
  { key: 'A', description: 'Approve all' },
  { key: 'D', description: 'Dashboard' },
  { key: 'Ctrl+C', description: 'Quit' },
];

function hintsForMode(mode: string): KeyHint[] {
  switch (mode) {
    case 'dashboard':
      return dashboardHints;
    case 'review':
      return reviewHints;
    default:
      return conversationalHints;
  }
}

export function App({
  store,
  apiClient,
  onStartJob,
  onExit: _onExit,
}: AppProps): React.ReactElement {
  const mode = useStore(store, (s) => s.mode);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Header mode={mode} />
      <Box flexGrow={1}>
        {mode === 'conversational' && (
          <ConversationalView store={store} onStartJob={onStartJob} />
        )}
        {mode === 'dashboard' && (
          <DashboardView store={store} apiClient={apiClient} />
        )}
        {mode === 'review' && (
          <ReviewView store={store} apiClient={apiClient} />
        )}
        {mode === 'explorer' && (
          <Text>Explorer mode — coming in Phase 9c</Text>
        )}
      </Box>
      <KeyboardHints hints={hintsForMode(mode)} />
    </Box>
  );
}
```

**Step 4: Update `new.tsx` to pass apiClient to App**

In `apps/cli/src/commands/new.tsx`, update the `<App>` render call to include the `apiClient` prop:

Change:

```typescript
    <App store={store} onStartJob={handleStartJob} onExit={handleExit} />,
```

To:

```typescript
    <App store={store} apiClient={apiClient} onStartJob={handleStartJob} onExit={handleExit} />,
```

**Step 5: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/cli test -- tests/unit/components/app.test.tsx`
Expected: ALL PASS (both old and new tests)

**Step 6: Run the full CLI test suite**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/cli test`
Expected: ALL PASS — no regressions.

**Step 7: Commit**

```bash
git add apps/cli/src/components/App.tsx apps/cli/src/commands/new.tsx apps/cli/tests/unit/components/app.test.tsx
git commit -m "feat(cli): wire DashboardView and ReviewView into App mode routing"
```

---

## Task 11: Build Verification + Full Test Suite

**Files:**

- No new files — this task verifies the entire Phase 9b build.

**Step 1: Run TypeScript compilation**

Run: `cd /Users/salar/Projects/spatula && pnpm run build`
Expected: All 7 packages compile cleanly with zero errors.

**Step 2: Run all tests across the monorepo**

Run: `cd /Users/salar/Projects/spatula && pnpm run test`
Expected: All tests pass. Report total counts.

**Step 3: Run CLI tests specifically with verbose output**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/cli test -- --reporter=verbose`
Expected: All Phase 9a and 9b tests pass. Verify the new test files are all included:

- `tests/unit/store/index.test.ts` (original + new job runtime state tests)
- `tests/unit/hooks/useJobPolling.test.ts`
- `tests/unit/hooks/useKeyboard.test.ts`
- `tests/unit/components/dashboard/progress-panel.test.tsx`
- `tests/unit/components/dashboard/schema-panel.test.tsx`
- `tests/unit/components/dashboard/activity-feed.test.tsx`
- `tests/unit/components/dashboard/entity-preview.test.tsx`
- `tests/unit/components/dashboard/dashboard-view.test.tsx`
- `tests/unit/components/review/action-card.test.tsx`
- `tests/unit/components/review/diff-preview.test.tsx`
- `tests/unit/components/review/review-view.test.tsx`
- `tests/unit/components/app.test.tsx` (updated)

**Step 4: Fix any TypeScript or test issues found**

If the build fails or tests fail, fix the issues and re-run.

**Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix(cli): resolve build/test issues from Phase 9b integration"
```
