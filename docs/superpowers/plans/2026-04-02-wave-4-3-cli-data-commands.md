# Wave 4-3: CLI Data Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build TUI-based and non-interactive CLI commands for exploring, exporting, reviewing, and inspecting crawl results locally. Reuse existing Ink components and adapted hooks from Wave 4-2.

**Architecture:** All data commands use `openLocalProject(cwd)` from `apps/cli/src/local-project.ts` to get a `DataSource`. Non-interactive commands (schema, logs, export) format output to stdout. TUI commands (explore, review) render Ink components via `render()` and block on `waitUntilExit()`. The existing `ExplorerView` and `ReviewView` components are adapted to accept `DataSource | SpatulaApiClient` as a `backend` prop (the hooks already handle both backends via the `isDataSource()` type guard). Dashboard mode `[d]` during `spatula run` toggles between compact progress and a full Ink TUI overlay.

**Tech Stack:** TypeScript, Ink/React (TUI), Zustand (store), Vitest (tests), yargs (CLI), DataSource interface (data access)

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `apps/cli/src/commands/schema.ts` | Non-interactive schema viewer (`spatula schema`) |
| `apps/cli/src/commands/logs.ts` | Non-interactive log viewer (`spatula logs`) |
| `apps/cli/src/commands/export.ts` | Non-interactive multi-format export (`spatula export`) |
| `apps/cli/src/commands/explore.tsx` | Standalone Ink TUI for entity browsing (`spatula explore`) |
| `apps/cli/src/commands/review.tsx` | Standalone Ink TUI for action review (`spatula review`) |
| `apps/cli/src/components/dashboard/RunDashboard.tsx` | Minimal Ink dashboard overlay for `spatula run` |
| `apps/cli/tests/unit/commands/schema.test.ts` | Tests for schema command |
| `apps/cli/tests/unit/commands/logs.test.ts` | Tests for logs command |
| `apps/cli/tests/unit/commands/export.test.ts` | Tests for export command |
| `apps/cli/tests/unit/commands/explore.test.ts` | Tests for explore command |
| `apps/cli/tests/unit/commands/review-cmd.test.ts` | Tests for review command |
| `apps/cli/tests/unit/commands/run-dashboard.test.ts` | Tests for dashboard toggle |

### Modified files

| File | Change |
|------|--------|
| `apps/cli/src/components/explorer/ExplorerView.tsx` | Accept `backend: DataSource \| SpatulaApiClient` instead of `apiClient: SpatulaApiClient` |
| `apps/cli/src/components/explorer/ExportDialog.tsx` | Accept `backend: DataSource \| SpatulaApiClient` instead of `apiClient: SpatulaApiClient` |
| `apps/cli/src/components/review/ReviewView.tsx` | Accept `backend: DataSource \| SpatulaApiClient`, use DataSource methods for approve/reject |
| `apps/cli/src/components/dashboard/DashboardView.tsx` | Accept `backend: DataSource \| SpatulaApiClient`, skip WebSocket in local mode |
| `apps/cli/src/components/App.tsx` | Thread `backend` prop instead of raw `apiClient` |
| `apps/cli/src/commands/run.ts` | Enhanced logging, stdin raw mode, dashboard `[d]` toggle |
| `apps/cli/src/index.tsx` | Register explore, export, review, schema, logs commands |

---

## Task 1: Adapt component props for DataSource backend

**Files:**
- Modify: `apps/cli/src/components/explorer/ExplorerView.tsx`
- Modify: `apps/cli/src/components/explorer/ExportDialog.tsx`
- Modify: `apps/cli/src/components/review/ReviewView.tsx`
- Modify: `apps/cli/src/components/dashboard/DashboardView.tsx`
- Modify: `apps/cli/src/components/App.tsx`
- Test: `apps/cli/tests/unit/commands/explore.test.ts` (deferred to Task 6)

All 4 hooks (`useJobPolling`, `useEntityData`, `useEntityFilter`, `useExport`) already accept `DataSource | SpatulaApiClient`. The components thread the backend through to the hooks — this task updates the prop types and adapts direct API calls.

- [ ] **Step 1: Update ExplorerView props**

In `apps/cli/src/components/explorer/ExplorerView.tsx`, change the interface and all usage:

```tsx
// Old
import type { SpatulaApiClient } from '../../api/client.js';

export interface ExplorerViewProps {
  store: CliStore;
  apiClient: SpatulaApiClient;
}

// New
import type { SpatulaApiClient } from '../../api/client.js';
import type { DataSource } from '@spatula/core';

export interface ExplorerViewProps {
  store: CliStore;
  backend: DataSource | SpatulaApiClient;
}
```

Update the function signature and all references inside the component. There are 3 places where `apiClient` is used:
1. `useEntityData(store, apiClient, ...)` → `useEntityData(store, backend, ...)`
2. `useEntityFilter(store, apiClient, ...)` → `useEntityFilter(store, backend, ...)`
3. `<ExportDialog store={store} apiClient={apiClient} .../>` → `<ExportDialog store={store} backend={backend} .../>`

- [ ] **Step 2: Update ExportDialog props**

In `apps/cli/src/components/explorer/ExportDialog.tsx`:

```tsx
// Old
export interface ExportDialogProps {
  store: CliStore;
  apiClient: SpatulaApiClient;
  fromDetail: boolean;
  onClose: () => void;
}

// New
import type { DataSource } from '@spatula/core';

export interface ExportDialogProps {
  store: CliStore;
  backend: DataSource | SpatulaApiClient;
  fromDetail: boolean;
  onClose: () => void;
}
```

Update usage: `useExport(apiClient)` → `useExport(backend)`.

- [ ] **Step 3: Update ReviewView props and adapt approve/reject**

In `apps/cli/src/components/review/ReviewView.tsx`:

```tsx
import type { DataSource } from '@spatula/core';
import { isDataSource } from '../../hooks/useJobPolling.js';

export interface ReviewViewProps {
  store: CliStore;
  backend: DataSource | SpatulaApiClient;
}
```

The ReviewView currently calls `apiClient.approveAction()`, `apiClient.rejectAction()`, `apiClient.approveAllActions()` directly. Adapt them:

```tsx
const approve = useCallback(() => {
  if (!currentAction) return;
  const actionId = currentAction.id;

  const doApprove = isDataSource(backend)
    ? backend.approveAction(actionId)
    : backend.approveAction(activeJobId!, actionId);

  void doApprove
    .then(() => {
      store.getState().removeAction(actionId);
      const remaining = store.getState().pendingActions.length;
      if (reviewIndex >= remaining && remaining > 0) {
        store.getState().setReviewIndex(remaining - 1);
      }
    })
    .catch((err) => {
      store.getState().setError(err instanceof Error ? err.message : 'Failed to approve action');
    });
}, [activeJobId, currentAction, backend, store, reviewIndex]);

const reject = useCallback(() => {
  if (!currentAction) return;
  const actionId = currentAction.id;

  const doReject = isDataSource(backend)
    ? backend.rejectAction(actionId)
    : backend.rejectAction(activeJobId!, actionId);

  void doReject
    .then(() => {
      store.getState().removeAction(actionId);
      const remaining = store.getState().pendingActions.length;
      if (reviewIndex >= remaining && remaining > 0) {
        store.getState().setReviewIndex(remaining - 1);
      }
    })
    .catch((err) => {
      store.getState().setError(err instanceof Error ? err.message : 'Failed to reject action');
    });
}, [activeJobId, currentAction, backend, store, reviewIndex]);

const approveAll = useCallback(() => {
  if (isDataSource(backend)) {
    // DataSource has no approveAllActions — iterate pending actions
    const actions = store.getState().pendingActions;
    void Promise.all(actions.map((a) => backend.approveAction(a.id)))
      .then(() => {
        store.getState().setPendingActions([]);
        store.getState().setReviewIndex(0);
      })
      .catch((err) => {
        store.getState().setError(err instanceof Error ? err.message : 'Failed to approve all');
      });
  } else {
    void backend.approveAllActions(activeJobId!)
      .then(() => {
        store.getState().setPendingActions([]);
        store.getState().setReviewIndex(0);
      })
      .catch((err) => {
        store.getState().setError(err instanceof Error ? err.message : 'Failed to approve all');
      });
  }
}, [activeJobId, backend, store]);
```

Also update `useJobPolling(store, apiClient, ...)` → `useJobPolling(store, backend, ...)`.

- [ ] **Step 4: Update DashboardView props**

In `apps/cli/src/components/dashboard/DashboardView.tsx`:

```tsx
import type { DataSource } from '@spatula/core';
import { isDataSource } from '../../hooks/useJobPolling.js';

export interface DashboardViewProps {
  store: CliStore;
  backend: DataSource | SpatulaApiClient;
}
```

Changes:
1. `useJobPolling(store, apiClient, ...)` → `useJobPolling(store, backend, ...)`
2. Fix `useWebSocket` to guard against empty `baseUrl` — add an early return in `apps/cli/src/hooks/useWebSocket.ts` at line 112, right after the existing `if (!jobId) return;`:
   ```tsx
   if (!jobId) return;
   if (!baseUrl) return; // No-op when no server URL (local DataSource mode)
   ```
   Then in DashboardView, since hooks can't be called conditionally, extract the WebSocket params:
   ```tsx
   const wsBaseUrl = isDataSource(backend) ? '' : backend.baseUrl;
   const wsTenantId = isDataSource(backend) ? '' : backend.tenantId;
   const { connected: wsConnected } = useWebSocket(store, wsBaseUrl, wsTenantId, activeJobId ?? '');
   ```
   The `useWebSocket` hook will now no-op cleanly when baseUrl is empty.
3. Guard pause/resume/cancel buttons — only show when `!isDataSource(backend)`:
   ```tsx
   useKeyboard(isDataSource(backend) ? {} : {
     ' ': () => { /* pause/resume */ },
     c: () => { /* cancel */ },
   });
   ```

- [ ] **Step 5: Update App.tsx to thread `backend` prop**

In `apps/cli/src/components/App.tsx`:

```tsx
import type { DataSource } from '@spatula/core';

export interface AppProps {
  store: CliStore;
  apiClient: SpatulaApiClient | null;
  backend?: DataSource | SpatulaApiClient | null;
  onStartJob: (config: Record<string, unknown>) => void;
  onExit: () => void;
}
```

In the render section, compute the effective backend:
```tsx
const effectiveBackend = backend ?? apiClient;
```

Then pass `backend={effectiveBackend}` to DashboardView, ReviewView, ExplorerView, and remove the `apiClient &&` guards (replace with `effectiveBackend &&`):

```tsx
{mode === 'dashboard' && effectiveBackend && (
  <DashboardView store={store} backend={effectiveBackend} />
)}
{mode === 'review' && effectiveBackend && (
  <ReviewView store={store} backend={effectiveBackend} />
)}
{mode === 'explorer' && effectiveBackend && (
  <ExplorerView store={store} backend={effectiveBackend} />
)}
{(mode === 'dashboard' || mode === 'review' || mode === 'explorer') && !effectiveBackend && (
  <Box paddingX={2} paddingY={1}>
    <Text color="yellow">
      {mode.charAt(0).toUpperCase() + mode.slice(1)} mode requires a remote connection or local project. Use `spatula run` for local crawling, or set SPATULA_TENANT_ID for remote mode.
    </Text>
  </Box>
)}
```

- [ ] **Step 6: Update existing component tests for prop rename**

The existing test files pass `apiClient` as a prop. Update them to use `backend`:
- `apps/cli/tests/unit/components/explorer/explorer-view.test.tsx`: Change all `apiClient={apiClient}` to `backend={apiClient}` in JSX, and rename the mock variable from `apiClient` to keep consistency (or just pass it as `backend`).
- Search for any other test files that render ExplorerView, ExportDialog, ReviewView, or DashboardView with an `apiClient` prop and update them.

In `explorer-view.test.tsx`, the key change:
```tsx
// Old
<ExplorerView store={store} apiClient={apiClient} />

// New
<ExplorerView store={store} backend={apiClient} />
```

Similarly for any ReviewView, DashboardView, or ExportDialog test files.

- [ ] **Step 7: Run existing tests**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter cli test -- --run`
Expected: All 344 tests pass (no behavior changes, only prop type widening + test prop renames).

- [ ] **Step 8: Commit**

```bash
git add apps/cli/src/components/explorer/ExplorerView.tsx \
       apps/cli/src/components/explorer/ExportDialog.tsx \
       apps/cli/src/components/review/ReviewView.tsx \
       apps/cli/src/components/dashboard/DashboardView.tsx \
       apps/cli/src/components/App.tsx
git commit -m "refactor(cli): adapt component props to accept DataSource backend

Components now accept DataSource | SpatulaApiClient via a 'backend' prop,
enabling local mode for explorer, review, and dashboard views."
```

---

## Task 2: `spatula schema` command

**Files:**
- Create: `apps/cli/src/commands/schema.ts`
- Test: `apps/cli/tests/unit/commands/schema.test.ts`

Non-interactive command that displays the current project schema: field table with name/type/required, version history with `--versions`, raw JSON with `--json`.

- [ ] **Step 1: Write tests for schema formatting**

Create `apps/cli/tests/unit/commands/schema.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { formatSchemaTable, formatVersionHistory } from '../../../src/commands/schema.js';

const sampleSchema = {
  id: 'schema-1',
  version: 3,
  definition: {
    version: 3,
    fields: [
      { name: 'title', type: 'string', required: true, description: 'Product title' },
      { name: 'price', type: 'currency', required: true, description: 'Product price' },
      { name: 'imageUrl', type: 'url', required: false, description: 'Main image URL' },
    ],
    fieldAliases: [],
    createdAt: new Date('2026-03-30'),
    parentVersion: 2,
  },
};

const sampleVersions = [
  {
    id: 'v3',
    version: 3,
    definition: {
      version: 3,
      fields: [
        { name: 'title', type: 'string', required: true, description: 'Product title' },
        { name: 'price', type: 'currency', required: true, description: 'Product price' },
        { name: 'imageUrl', type: 'url', required: false, description: 'Main image URL' },
      ],
      fieldAliases: [],
      createdAt: new Date('2026-03-30'),
      parentVersion: 2,
    },
    parentId: 'v2',
    createdAt: '2026-03-30T12:00:00Z',
  },
  {
    id: 'v2',
    version: 2,
    definition: {
      version: 2,
      fields: [
        { name: 'title', type: 'string', required: true, description: 'Product title' },
        { name: 'price', type: 'currency', required: true, description: 'Product price' },
      ],
      fieldAliases: [],
      createdAt: new Date('2026-03-29'),
      parentVersion: 1,
    },
    parentId: 'v1',
    createdAt: '2026-03-29T12:00:00Z',
  },
];

describe('formatSchemaTable', () => {
  it('formats schema fields as a table', () => {
    const output = formatSchemaTable(sampleSchema);
    expect(output).toContain('Version: 3');
    expect(output).toContain('Fields: 3');
    expect(output).toContain('title');
    expect(output).toContain('string');
    expect(output).toContain('yes');
    expect(output).toContain('price');
    expect(output).toContain('currency');
    expect(output).toContain('imageUrl');
    expect(output).toContain('no');
  });

  it('returns message when no schema exists', () => {
    const output = formatSchemaTable(null);
    expect(output).toContain('No schema');
  });
});

describe('formatVersionHistory', () => {
  it('formats version list with field count diff', () => {
    const output = formatVersionHistory(sampleVersions);
    expect(output).toContain('v3');
    expect(output).toContain('3 fields');
    expect(output).toContain('v2');
    expect(output).toContain('2 fields');
  });

  it('returns message when no versions exist', () => {
    const output = formatVersionHistory([]);
    expect(output).toContain('No schema versions');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter cli test -- --run tests/unit/commands/schema.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement schema command**

Create `apps/cli/src/commands/schema.ts`:

```typescript
/**
 * `spatula schema` — display the current project schema.
 *
 * Non-interactive. Reads schema from DataSource, formats as table.
 * Supports --versions for version history and --json for raw output.
 */
import { openLocalProject } from '../local-project.js';

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

interface SchemaField {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

interface SchemaRow {
  id: string;
  version: number;
  definition: {
    version: number;
    fields: SchemaField[];
    fieldAliases?: unknown[];
    createdAt: Date;
    parentVersion: number | null;
  };
}

interface VersionRow {
  id: string;
  version: number;
  definition: {
    version: number;
    fields: SchemaField[];
    [key: string]: unknown;
  };
  parentId: string | null;
  createdAt: string;
}

export function formatSchemaTable(schema: SchemaRow | null): string {
  if (!schema) return '  No schema found. Run `spatula run` to discover a schema.\n';

  const fields = schema.definition.fields ?? [];
  const lines: string[] = [];

  lines.push(`  Schema — Version: ${schema.definition.version}  |  Fields: ${fields.length}`);
  lines.push('');

  if (fields.length === 0) {
    lines.push('  No fields defined.');
    return lines.join('\n') + '\n';
  }

  // Table header
  const nameW = Math.max(20, ...fields.map((f) => f.name.length + 2));
  const typeW = 12;
  const reqW = 10;
  const descW = 40;

  lines.push(
    '  ' +
    'Name'.padEnd(nameW) +
    'Type'.padEnd(typeW) +
    'Required'.padEnd(reqW) +
    'Description',
  );
  lines.push('  ' + '─'.repeat(nameW + typeW + reqW + descW));

  for (const field of fields) {
    const req = field.required ? 'yes' : 'no';
    const desc = field.description ?? '';
    lines.push(
      '  ' +
      field.name.padEnd(nameW) +
      field.type.padEnd(typeW) +
      req.padEnd(reqW) +
      desc.slice(0, descW),
    );
  }

  return lines.join('\n') + '\n';
}

export function formatVersionHistory(versions: VersionRow[]): string {
  if (versions.length === 0) return '  No schema versions found.\n';

  const lines: string[] = [];
  lines.push('  Schema Version History');
  lines.push('  ' + '─'.repeat(60));

  for (const v of versions) {
    const fieldCount = v.definition.fields?.length ?? 0;
    const date = v.createdAt.slice(0, 19).replace('T', ' ');
    lines.push(`  v${v.version}  |  ${fieldCount} fields  |  ${date}`);
  }

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export interface SchemaOptions {
  versions?: boolean;
  json?: boolean;
}

export async function runSchemaCommand(options: SchemaOptions = {}): Promise<void> {
  const project = await openLocalProject(process.cwd());

  try {
    if (options.json) {
      const schema = await project.dataSource.getSchema();
      console.log(JSON.stringify(schema, null, 2));
      return;
    }

    if (options.versions) {
      const versions = await project.dataSource.getSchemaVersions();
      console.log(formatVersionHistory(versions as VersionRow[]));
      return;
    }

    const schema = await project.dataSource.getSchema();
    console.log(formatSchemaTable(schema as SchemaRow | null));
  } finally {
    project.close();
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter cli test -- --run tests/unit/commands/schema.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/commands/schema.ts apps/cli/tests/unit/commands/schema.test.ts
git commit -m "feat(cli): add spatula schema command

Non-interactive schema viewer showing fields table, version history
(--versions), or raw JSON (--json)."
```

---

## Task 3: `spatula logs` command

**Files:**
- Create: `apps/cli/src/commands/logs.ts`
- Test: `apps/cli/tests/unit/commands/logs.test.ts`
- Modify: `apps/cli/src/commands/run.ts` (enhance log format)

The current run.ts writes ndjson entries with `{event, ts, ...stats}`. We enhance these to include `level` and `msg` fields, then build a logs command that reads and formats them.

- [ ] **Step 1: Write tests for log parsing and formatting**

Create `apps/cli/tests/unit/commands/logs.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseLogEntry, formatLogEntry, filterByLevel, listLogFiles } from '../../../src/commands/logs.js';

describe('parseLogEntry', () => {
  it('parses a valid ndjson log line', () => {
    const line = '{"level":"info","msg":"Pipeline started","ts":"2026-03-31T12:00:00.000Z","event":"run:start","runId":"abc-123"}';
    const entry = parseLogEntry(line);
    expect(entry).toEqual({
      level: 'info',
      msg: 'Pipeline started',
      ts: '2026-03-31T12:00:00.000Z',
      event: 'run:start',
      runId: 'abc-123',
    });
  });

  it('returns null for invalid JSON', () => {
    expect(parseLogEntry('not json')).toBeNull();
    expect(parseLogEntry('')).toBeNull();
  });
});

describe('formatLogEntry', () => {
  it('formats entry with timestamp, level, and message', () => {
    const entry = { level: 'info', msg: 'Page crawled', ts: '2026-03-31T12:00:05.000Z', event: 'task:completed', url: 'https://example.com' };
    const output = formatLogEntry(entry);
    expect(output).toContain('12:00:05');
    expect(output).toContain('INFO');
    expect(output).toContain('Page crawled');
  });

  it('includes extra fields after message', () => {
    const entry = { level: 'info', msg: 'Progress', ts: '2026-03-31T12:00:05.000Z', event: 'progress', pagesProcessed: 5, entitiesCreated: 3 };
    const output = formatLogEntry(entry);
    expect(output).toContain('pages=5');
    expect(output).toContain('entities=3');
  });
});

describe('filterByLevel', () => {
  it('filters entries to error level only', () => {
    const entries = [
      { level: 'info', msg: 'a', ts: '1' },
      { level: 'error', msg: 'b', ts: '2' },
      { level: 'warn', msg: 'c', ts: '3' },
    ];
    expect(filterByLevel(entries, 'error')).toEqual([{ level: 'error', msg: 'b', ts: '2' }]);
  });
});

describe('listLogFiles', () => {
  it('returns empty array for non-existent directory', () => {
    const files = listLogFiles('/nonexistent/path');
    expect(files).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter cli test -- --run tests/unit/commands/logs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Enhance run.ts logging**

In `apps/cli/src/commands/run.ts`, update the log format to include `level`, `msg`, and `runId` fields. Change the `logToFile` helper and add more log points:

Find the existing logToFile definition (around line 102):
```typescript
  const logToFile = (entry: Record<string, unknown>) => {
    try { appendFileSync(logFile, JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n'); } catch { /* non-fatal */ }
  };
```

Replace with:
```typescript
  let currentRunId = '';
  const logToFile = (level: string, msg: string, extra: Record<string, unknown> = {}) => {
    try {
      appendFileSync(logFile, JSON.stringify({
        level, msg, ...extra, runId: currentRunId, ts: new Date().toISOString(),
      }) + '\n');
    } catch { /* non-fatal */ }
  };
```

Update the progress event listener (around line 229):
```typescript
  runner.events.on('progress', (stats: any) => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const pct =
      stats.totalPages > 0
        ? Math.round((stats.pagesProcessed / stats.totalPages) * 100)
        : 0;
    process.stdout.write(
      `\r  Pages: ${stats.pagesProcessed}/${stats.totalPages} (${pct}%)` +
      `  Entities: ${stats.entitiesCreated}` +
      `  Errors: ${stats.errors}` +
      `  Elapsed: ${elapsed}s  `,
    );
    logToFile('info', 'Progress', { event: 'progress', pagesProcessed: stats.pagesProcessed, totalPages: stats.totalPages, entitiesCreated: stats.entitiesCreated, errors: stats.errors, elapsed });
  });
```

Update the schema evolution listener (around line 245):
```typescript
  runner.events.on('schema:evolved', (schema: any) => {
    process.stdout.write('\n');
    console.log(`  Schema evolved → version ${schema.version}`);
    logToFile('info', `Schema evolved to version ${schema.version}`, { event: 'schema:evolved', version: schema.version });
  });
```

Add a run start log after currentRunId is available. After the runner is created but before `runner.run()`, the run creates a run record internally. We'll log the start just before running:
```typescript
  logToFile('info', `Pipeline starting for ${projectName}`, { event: 'run:start', projectName, projectRoot, crawler: crawlerType, llm: llmClient ? 'available' : 'unavailable' });
```

Add completion/failure logs in the try/catch (around lines 261 and 277):
```typescript
  // In the success block:
  logToFile('info', 'Pipeline complete', { event: 'run:complete' });

  // In the catch block:
  logToFile('error', `Pipeline failed: ${errMsg}`, { event: 'run:failed', error: errMsg });
```

- [ ] **Step 4: Implement logs command**

Create `apps/cli/src/commands/logs.ts`:

```typescript
/**
 * `spatula logs` — view structured log files from spatula run.
 *
 * Reads ndjson log files from .spatula/logs/, formats output with
 * timestamp, level, message, and key fields.
 */
import { readFileSync, readdirSync, existsSync, watch } from 'node:fs';
import { join } from 'node:path';
import { findProjectRoot } from '@spatula/core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LogEntry {
  level: string;
  msg: string;
  ts: string;
  event?: string;
  runId?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Parsing & formatting
// ---------------------------------------------------------------------------

export function parseLogEntry(line: string): LogEntry | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line) as LogEntry;
  } catch {
    return null;
  }
}

const LEVEL_COLORS: Record<string, string> = {
  error: '\x1b[31m',  // red
  warn: '\x1b[33m',   // yellow
  info: '\x1b[36m',   // cyan
  debug: '\x1b[90m',  // gray
};
const RESET = '\x1b[0m';

/** Fields that are already shown in the structured output — skip in "extras". */
const SKIP_FIELDS = new Set(['level', 'msg', 'ts', 'event', 'runId']);

export function formatLogEntry(entry: LogEntry): string {
  const time = entry.ts?.slice(11, 19) ?? '??:??:??';
  const level = (entry.level ?? 'info').toUpperCase().padEnd(5);
  const color = LEVEL_COLORS[entry.level] ?? '';
  const msg = entry.msg ?? entry.event ?? '';

  // Collect extra fields
  const extras = Object.entries(entry)
    .filter(([k]) => !SKIP_FIELDS.has(k))
    .map(([k, v]) => {
      // Shorten known keys
      if (k === 'pagesProcessed') return `pages=${v}`;
      if (k === 'entitiesCreated') return `entities=${v}`;
      if (k === 'totalPages') return `total=${v}`;
      if (k === 'errors') return `errors=${v}`;
      if (k === 'elapsed') return `${v}s`;
      return `${k}=${v}`;
    })
    .join(' ');

  return `${color}${time} ${level}${RESET} ${msg}${extras ? '  ' + extras : ''}`;
}

export function filterByLevel(entries: LogEntry[], level: string): LogEntry[] {
  return entries.filter((e) => e.level === level);
}

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

export function listLogFiles(logsDir: string): string[] {
  if (!existsSync(logsDir)) return [];
  try {
    return readdirSync(logsDir)
      .filter((f) => f.endsWith('.log'))
      .sort()
      .reverse(); // newest first
  } catch {
    return [];
  }
}

function readLogFile(filePath: string): LogEntry[] {
  const content = readFileSync(filePath, 'utf-8');
  return content
    .split('\n')
    .map(parseLogEntry)
    .filter((e): e is LogEntry => e !== null);
}

// ---------------------------------------------------------------------------
// Tail mode
// ---------------------------------------------------------------------------

function tailLogFile(filePath: string, errorsOnly: boolean): void {
  let position = 0;
  try {
    position = readFileSync(filePath).byteLength;
  } catch {
    // File may not exist yet
  }

  console.log(`Tailing ${filePath}... (Ctrl+C to stop)\n`);

  const checkNewContent = () => {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const newContent = content.slice(position);
      position = content.length;
      if (newContent) {
        const entries = newContent.split('\n').map(parseLogEntry).filter((e): e is LogEntry => e !== null);
        const filtered = errorsOnly ? filterByLevel(entries, 'error') : entries;
        for (const entry of filtered) {
          console.log(formatLogEntry(entry));
        }
      }
    } catch { /* file may be temporarily unavailable */ }
  };

  const watcher = watch(filePath, () => checkNewContent());

  process.on('SIGINT', () => {
    watcher.close();
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export interface LogsOptions {
  run?: string;
  errors?: boolean;
  tail?: boolean;
}

export async function runLogsCommand(options: LogsOptions = {}): Promise<void> {
  const projectRoot = findProjectRoot(process.cwd());
  if (!projectRoot) {
    console.error('Error: no spatula.yaml found. Run from a project directory.');
    process.exit(1);
  }

  const logsDir = join(projectRoot, '.spatula', 'logs');
  const files = listLogFiles(logsDir);

  if (files.length === 0) {
    console.log('  No log files found. Run `spatula run` to create logs.\n');
    return;
  }

  // Determine which file to show
  let targetFile: string;
  if (options.run) {
    // Try to match by run ID in log entries, or by filename prefix
    const byName = files.find((f) => f.startsWith(options.run!));
    if (byName) {
      targetFile = join(logsDir, byName);
    } else {
      // Search for a file containing a matching runId
      let found: string | null = null;
      for (const f of files) {
        const content = readFileSync(join(logsDir, f), 'utf-8');
        if (content.includes(`"runId":"${options.run}"`)) {
          found = join(logsDir, f);
          break;
        }
      }
      if (!found) {
        console.error(`  No log file found for run "${options.run}".`);
        console.error(`  Available logs: ${files.slice(0, 5).join(', ')}${files.length > 5 ? '...' : ''}`);
        process.exit(1);
      }
      targetFile = found;
    }
  } else {
    targetFile = join(logsDir, files[0]); // latest
  }

  // Tail mode
  if (options.tail) {
    if (!process.stdin.isTTY) {
      console.error('Error: --tail requires an interactive terminal.');
      process.exit(1);
    }
    tailLogFile(targetFile, options.errors ?? false);
    return; // tailLogFile blocks until SIGINT
  }

  // Read and display
  let entries = readLogFile(targetFile);
  if (options.errors) {
    entries = filterByLevel(entries, 'error');
  }

  if (entries.length === 0) {
    console.log(options.errors ? '  No error entries found.\n' : '  Log file is empty.\n');
    return;
  }

  console.log(`  Log: ${targetFile}\n`);
  for (const entry of entries) {
    console.log(formatLogEntry(entry));
  }
  console.log('');
}
```

- [ ] **Step 5: Run tests**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter cli test -- --run tests/unit/commands/logs.test.ts`
Expected: All tests pass.

- [ ] **Step 6: Run full test suite**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter cli test -- --run`
Expected: All tests pass (including existing tests, since run.ts changes are additive).

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/commands/logs.ts apps/cli/tests/unit/commands/logs.test.ts apps/cli/src/commands/run.ts
git commit -m "feat(cli): add spatula logs command and enhance run logging

Structured ndjson logs now include level/msg/runId fields. New logs
command supports --errors, --tail (follow mode), and --run filters."
```

---

## Task 4: `spatula export` command (non-interactive)

**Files:**
- Create: `apps/cli/src/commands/export.ts`
- Test: `apps/cli/tests/unit/commands/export.test.ts`

Non-interactive export using the existing exporter classes from `@spatula/core`. Supports 5 formats: json, csv, sqlite, parquet, duckdb.

**Deliberate spec deviation:** The spec says "Calls `processExport()` orchestrator directly via `openLocalProject`". We instead use individual exporter classes directly (JsonExporter, CsvExporter, etc.) because `processExport()` requires server-side dependencies (jobRepo, exportRepo, ContentStore), validates that the job status is 'completed' (doesn't apply in local mode), and tracks export records in the database. For the CLI export command, loading entities from DataSource and running the exporter directly is simpler, faster, and doesn't need the orchestrator's server-side assumptions.

- [ ] **Step 1: Write tests for export helpers**

Create `apps/cli/tests/unit/commands/export.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { resolveOutputPath, validateFormat } from '../../../src/commands/export.js';

describe('validateFormat', () => {
  it('accepts valid formats', () => {
    for (const fmt of ['json', 'csv', 'sqlite', 'parquet', 'duckdb']) {
      expect(validateFormat(fmt)).toBe(fmt);
    }
  });

  it('throws for invalid format', () => {
    expect(() => validateFormat('xml')).toThrow('Unsupported');
  });
});

describe('resolveOutputPath', () => {
  it('uses provided output path', () => {
    expect(resolveOutputPath('/tmp/out.json', 'json', '/project')).toBe('/tmp/out.json');
  });

  it('generates default path under .spatula/exports/', () => {
    const result = resolveOutputPath(undefined, 'csv', '/project');
    expect(result).toMatch(/\/project\/\.spatula\/exports\/\d{4}-\d{2}-\d{2}T[\d-]+\.csv$/);
  });

  it('uses correct extension for each format', () => {
    for (const fmt of ['json', 'csv', 'sqlite', 'parquet', 'duckdb'] as const) {
      const result = resolveOutputPath(undefined, fmt, '/project');
      expect(result).toContain(`.${fmt}`);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter cli test -- --run tests/unit/commands/export.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement export command**

Create `apps/cli/src/commands/export.ts`:

```typescript
/**
 * `spatula export` — non-interactive multi-format export.
 *
 * Exports entities from the local project database to a file.
 * Uses exporter classes from @spatula/core directly (no server-side
 * orchestrator dependency).
 */
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { openLocalProject } from '../local-project.js';
import type { Entity } from '@spatula/shared';
import type { ExportFormat, ExportOptions, SchemaDefinition } from '@spatula/core';
import {
  JsonExporter,
  CsvExporter,
  SqliteExporter,
  ParquetExporter,
  DuckDBExporter,
} from '@spatula/core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_FORMATS = new Set(['json', 'csv', 'sqlite', 'parquet', 'duckdb']);

export function validateFormat(format: string): ExportFormat {
  if (!VALID_FORMATS.has(format)) {
    throw new Error(`Unsupported export format: "${format}". Valid formats: ${[...VALID_FORMATS].join(', ')}`);
  }
  return format as ExportFormat;
}

export function resolveOutputPath(
  output: string | undefined,
  format: string,
  projectRoot: string,
): string {
  if (output) return output;
  const exportsDir = join(projectRoot, '.spatula', 'exports');
  mkdirSync(exportsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/:/g, '-').slice(0, 19);
  return join(exportsDir, `${timestamp}.${format}`);
}

function getExporter(format: ExportFormat) {
  switch (format) {
    case 'json': return new JsonExporter();
    case 'csv': return new CsvExporter();
    case 'sqlite': return new SqliteExporter();
    case 'parquet': return new ParquetExporter();
    case 'duckdb': return new DuckDBExporter();
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export interface ExportCommandOptions {
  format?: string;
  output?: string;
  includeProvenance?: boolean;
  minQuality?: number;
}

export async function runExportCommand(options: ExportCommandOptions = {}): Promise<void> {
  const format = validateFormat(options.format ?? 'json');
  const project = await openLocalProject(process.cwd());

  try {
    const outputPath = resolveOutputPath(options.output, format, project.projectRoot);

    // 1. Get schema
    const schemaRaw = await project.dataSource.getSchema();
    if (!schemaRaw) {
      console.error('Error: no schema found. Run `spatula run` first to discover a schema.');
      process.exit(1);
    }
    const schemaRow = schemaRaw as { definition: SchemaDefinition };
    const schema = schemaRow.definition;

    // 2. Batch-load all entities
    const allEntities: Entity[] = [];
    let offset = 0;
    const batchSize = 200;
    while (true) {
      const result = await project.dataSource.getEntities({ limit: batchSize, offset });
      allEntities.push(...result.data);
      if (allEntities.length >= result.total) break;
      offset += batchSize;
    }

    // 3. Apply min-quality filter
    let entities = allEntities;
    if (options.minQuality !== undefined) {
      entities = allEntities.filter((e) => e.qualityScore >= options.minQuality!);
    }

    if (entities.length === 0) {
      console.log('  No entities to export' +
        (options.minQuality !== undefined ? ` (min quality: ${options.minQuality})` : '') +
        '.\n');
      return;
    }

    // 4. Run exporter
    const includeProvenance = format === 'json' && (options.includeProvenance ?? false);
    const exporter = getExporter(format);
    const result = await exporter.export(entities, schema, {
      format,
      includeProvenance,
      includeDocumentation: format === 'json',
    } as ExportOptions);

    // 5. Write to disk
    if (result.binaryData) {
      writeFileSync(outputPath, result.binaryData);
    } else if (result.data) {
      writeFileSync(outputPath, result.data as string, 'utf-8');
    } else if (result.filePath) {
      // Some exporters write directly to disk
      console.log(`  Exported ${entities.length} entities → ${result.filePath}`);
      console.log(`  Format: ${format}\n`);
      return;
    }

    const { statSync } = await import('node:fs');
    const fileSize = statSync(outputPath).size;
    const sizeStr = fileSize > 1024 * 1024
      ? `${(fileSize / 1024 / 1024).toFixed(1)} MB`
      : `${(fileSize / 1024).toFixed(1)} KB`;

    console.log(`  Exported ${entities.length} entities → ${outputPath}`);
    console.log(`  Format: ${format}  |  Size: ${sizeStr}`);
    if (includeProvenance) console.log('  Provenance: included');
    console.log('');
  } finally {
    project.close();
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter cli test -- --run tests/unit/commands/export.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/commands/export.ts apps/cli/tests/unit/commands/export.test.ts
git commit -m "feat(cli): add spatula export command

Non-interactive export supporting json, csv, sqlite, parquet, duckdb
formats with --output, --include-provenance, and --min-quality flags."
```

---

## Task 5: `spatula explore` command

**Files:**
- Create: `apps/cli/src/commands/explore.tsx`
- Test: `apps/cli/tests/unit/commands/explore.test.ts`

Standalone Ink TUI that wraps the existing `ExplorerView` component. Opens a local project, creates a store, and renders the entity browser.

- [ ] **Step 1: Write tests for explore command setup**

Create `apps/cli/tests/unit/commands/explore.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { buildExploreStore } from '../../../src/commands/explore.js';

describe('buildExploreStore', () => {
  it('creates a store with activeJobId set to projectId', () => {
    const store = buildExploreStore('test-project');
    const state = store.getState();
    expect(state.activeJobId).toBe('test-project');
    expect(state.mode).toBe('explorer');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter cli test -- --run tests/unit/commands/explore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement explore command**

Create `apps/cli/src/commands/explore.tsx`:

```tsx
/**
 * `spatula explore` — standalone entity browser TUI.
 *
 * Opens the local project, creates a store, and renders the ExplorerView
 * Ink component. Press 'q' or Escape to exit.
 */
import React, { useState, useCallback } from 'react';
import { render, Box, Text } from 'ink';
import { openLocalProject } from '../local-project.js';
import { createCliStore } from '../store/index.js';
import type { CliStore } from '../store/index.js';
import { ExplorerView } from '../components/explorer/ExplorerView.js';
import { useKeyboard } from '../hooks/useKeyboard.js';
import { Header } from '../components/shared/index.js';

// ---------------------------------------------------------------------------
// Store factory (exported for testing)
// ---------------------------------------------------------------------------

export function buildExploreStore(projectId: string): CliStore {
  const store = createCliStore(projectId);
  store.getState().setActiveJobId(projectId);
  store.getState().setMode('explorer');
  return store;
}

// ---------------------------------------------------------------------------
// Wrapper component
// ---------------------------------------------------------------------------

interface ExploreAppProps {
  store: CliStore;
  backend: import('@spatula/core').DataSource;
  onExit: () => void;
}

function ExploreApp({ store, backend, onExit }: ExploreAppProps): React.ReactElement {
  const handleExit = useCallback(() => {
    onExit();
  }, [onExit]);

  // Override the ExplorerView's Escape handler: instead of switching to
  // conversational mode, exit the app entirely.
  // Sort support: cycle through sort modes with 'o' (order)
  const [sortBy, setSortBy] = useState<'default' | 'quality' | 'date'>('default');
  const handleSort = useCallback(() => {
    setSortBy((prev) => {
      const next = prev === 'default' ? 'quality' : prev === 'quality' ? 'date' : 'default';
      // Apply sort to store entities
      const state = store.getState();
      const sorted = [...state.entities].sort((a, b) => {
        if (next === 'quality') return b.qualityScore - a.qualityScore;
        if (next === 'date') return b.createdAt.localeCompare(a.createdAt);
        return 0; // default: server order
      });
      state.setEntities(sorted);
      return next;
    });
  }, [store]);

  useKeyboard({
    q: handleExit,
    Q: handleExit,
    o: handleSort,
    O: handleSort,
  });

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Header mode="explorer" />
      <ExplorerView store={store} backend={backend} />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

export async function runExploreCommand(): Promise<void> {
  const project = await openLocalProject(process.cwd());

  const store = buildExploreStore(project.projectId);

  // Check if there are any entities
  const status = await project.dataSource.getStatus();
  if (status.totalEntities === 0) {
    console.log('  No entities found. Run `spatula run` first to crawl and extract data.\n');
    project.close();
    return;
  }

  const { unmount, waitUntilExit } = render(
    <ExploreApp
      store={store}
      backend={project.dataSource}
      onExit={() => unmount()}
    />,
  );

  await waitUntilExit();
  project.close();
}
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter cli test -- --run tests/unit/commands/explore.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/commands/explore.tsx apps/cli/tests/unit/commands/explore.test.ts
git commit -m "feat(cli): add spatula explore command

Standalone Ink TUI entity browser. Opens local project, renders
ExplorerView with DataSource backend for browsing/filtering/exporting."
```

---

## Task 6: `spatula review` command

**Files:**
- Create: `apps/cli/src/commands/review.tsx`
- Test: `apps/cli/tests/unit/commands/review-cmd.test.ts`

Standalone Ink TUI wrapping ReviewView. Shows pending schema actions for approve/reject. Prints summary on exit.

- [ ] **Step 1: Write tests for review command setup**

Create `apps/cli/tests/unit/commands/review-cmd.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildReviewStore, formatReviewSummary } from '../../../src/commands/review.js';

describe('buildReviewStore', () => {
  it('creates a store with activeJobId set to projectId', () => {
    const store = buildReviewStore('test-project');
    const state = store.getState();
    expect(state.activeJobId).toBe('test-project');
    expect(state.mode).toBe('review');
  });
});

describe('formatReviewSummary', () => {
  it('formats counts correctly', () => {
    const output = formatReviewSummary(4, 2);
    expect(output).toContain('Reviewed 4');
    expect(output).toContain('2 remaining');
  });

  it('handles zero counts', () => {
    const output = formatReviewSummary(0, 0);
    expect(output).toContain('Reviewed 0');
    expect(output).toContain('0 remaining');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter cli test -- --run tests/unit/commands/review-cmd.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement review command**

Create `apps/cli/src/commands/review.tsx`:

```tsx
/**
 * `spatula review` — standalone action review TUI.
 *
 * Opens the local project, shows pending schema actions for
 * approve/reject, and prints a summary on exit.
 */
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { render, Box, Text } from 'ink';
import { useStore } from 'zustand';
import { openLocalProject } from '../local-project.js';
import { createCliStore } from '../store/index.js';
import type { CliStore } from '../store/index.js';
import { ReviewView } from '../components/review/ReviewView.js';
import { useKeyboard } from '../hooks/useKeyboard.js';
import { Header, KeyboardHints } from '../components/shared/index.js';
import type { KeyHint } from '../components/shared/index.js';

// ---------------------------------------------------------------------------
// Store factory & formatting (exported for testing)
// ---------------------------------------------------------------------------

export function buildReviewStore(projectId: string): CliStore {
  const store = createCliStore(projectId);
  store.getState().setActiveJobId(projectId);
  store.getState().setMode('review');
  return store;
}

export function formatReviewSummary(processed: number, remaining: number): string {
  return `  Reviewed ${processed} action(s), ${remaining} remaining.`;
}

// ---------------------------------------------------------------------------
// Review app
// ---------------------------------------------------------------------------

const REVIEW_HINTS: KeyHint[] = [
  { key: 'Y/N', description: 'Approve/Reject' },
  { key: '↑/↓', description: 'Navigate' },
  { key: 'A', description: 'Approve all' },
  { key: 'S', description: 'Skip' },
  { key: 'Q', description: 'Quit' },
];

interface ReviewAppProps {
  store: CliStore;
  backend: import('@spatula/core').DataSource;
  initialCount: number;
  onExit: (processed: number, remaining: number) => void;
}

function ReviewApp({ store, backend, initialCount, onExit }: ReviewAppProps): React.ReactElement {
  const pendingActions = useStore(store, (s) => s.pendingActions);

  const handleQuit = useCallback(() => {
    const remaining = pendingActions.length;
    const processed = initialCount - remaining;
    onExit(processed, remaining);
  }, [onExit, pendingActions.length, initialCount]);

  const handleSkip = useCallback(() => {
    const idx = store.getState().reviewIndex;
    const max = store.getState().pendingActions.length - 1;
    if (idx < max) {
      store.getState().setReviewIndex(idx + 1);
    }
  }, [store]);

  useKeyboard({
    q: handleQuit,
    Q: handleQuit,
    s: handleSkip,
    S: handleSkip,
  });

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Header mode="review" />
      <ReviewView store={store} backend={backend} />
      <KeyboardHints hints={REVIEW_HINTS} />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

export async function runReviewCommand(): Promise<void> {
  const project = await openLocalProject(process.cwd());

  const store = buildReviewStore(project.projectId);

  // Check for pending actions
  const actions = await project.dataSource.getActions('pending_review');
  if ((actions as unknown[]).length === 0) {
    console.log('  No pending actions to review.\n');
    project.close();
    return;
  }

  const initialCount = (actions as unknown[]).length;
  console.log(`  ${initialCount} pending action(s) to review.\n`);

  let summary = '';

  const { unmount, waitUntilExit } = render(
    <ReviewApp
      store={store}
      backend={project.dataSource}
      initialCount={initialCount}
      onExit={(processed, remaining) => {
        summary = formatReviewSummary(processed, remaining);
        unmount();
      }}
    />,
  );

  await waitUntilExit();
  project.close();

  if (summary) {
    console.log('\n' + summary + '\n');
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter cli test -- --run tests/unit/commands/review-cmd.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/commands/review.tsx apps/cli/tests/unit/commands/review-cmd.test.ts
git commit -m "feat(cli): add spatula review command

Standalone Ink TUI for reviewing pending schema actions. Approve/reject
individual actions or approve all. Prints summary on exit."
```

---

## Task 7: Dashboard mode `[d]` during `spatula run`

**Files:**
- Create: `apps/cli/src/components/dashboard/RunDashboard.tsx`
- Modify: `apps/cli/src/commands/run.ts`
- Test: `apps/cli/tests/unit/commands/run-dashboard.test.ts`

Adds a `[d]` keybinding during `spatula run` that expands the compact progress line into a full Ink TUI dashboard overlay. The pipeline continues running in the background. Press `[d]` again or `Esc` to return to compact mode.

- [ ] **Step 1: Write tests for RunDashboard helpers**

Create `apps/cli/tests/unit/commands/run-dashboard.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildRunDashboardStore } from '../../../src/components/dashboard/RunDashboard.js';

describe('buildRunDashboardStore', () => {
  it('creates a store with activeJobId set', () => {
    const store = buildRunDashboardStore('test-project');
    const state = store.getState();
    expect(state.activeJobId).toBe('test-project');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter cli test -- --run tests/unit/commands/run-dashboard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create RunDashboard component**

Create `apps/cli/src/components/dashboard/RunDashboard.tsx`:

```tsx
/**
 * RunDashboard — minimal Ink dashboard overlay for `spatula run`.
 *
 * Shows live pipeline stats (pages, entities, schema, errors) using
 * the DataSource to poll the local SQLite database. Dismisses with
 * 'd' or Escape.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { useStore } from 'zustand';
import { createCliStore } from '../../store/index.js';
import type { CliStore } from '../../store/index.js';
import type { DataSource } from '@spatula/core';
import { useJobPolling } from '../../hooks/useJobPolling.js';
import { useKeyboard } from '../../hooks/useKeyboard.js';
import { ProgressPanel } from './ProgressPanel.js';
import { SchemaPanel } from './SchemaPanel.js';
import { EntityPreview } from './EntityPreview.js';
import { KeyboardHints } from '../shared/index.js';
import type { KeyHint } from '../shared/index.js';

// ---------------------------------------------------------------------------
// Store factory (exported for testing)
// ---------------------------------------------------------------------------

export function buildRunDashboardStore(projectId: string): CliStore {
  const store = createCliStore(projectId);
  store.getState().setActiveJobId(projectId);
  return store;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const HINTS: KeyHint[] = [
  { key: 'D', description: 'Close dashboard' },
  { key: 'Esc', description: 'Close dashboard' },
  { key: 'Ctrl+C', description: 'Stop pipeline' },
];

interface RunDashboardProps {
  store: CliStore;
  dataSource: DataSource;
  projectName: string;
  onDismiss: () => void;
}

export function RunDashboard({
  store,
  dataSource,
  projectName,
  onDismiss,
}: RunDashboardProps): React.ReactElement {
  const activeJobId = useStore(store, (s) => s.activeJobId);
  const jobData = useStore(store, (s) => s.jobData);
  const schemaData = useStore(store, (s) => s.schemaData);
  const entityPreviews = useStore(store, (s) => s.entityPreviews);

  // Poll local DB every 2 seconds for live stats
  useJobPolling(store, dataSource, activeJobId ?? '', 2000);

  useKeyboard({
    d: onDismiss,
    D: onDismiss,
    escape: onDismiss,
  });

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box gap={1} marginBottom={1}>
        <Text bold color="cyan">Dashboard</Text>
        <Text dimColor>— {projectName}</Text>
      </Box>

      <Box flexGrow={1}>
        <Box flexDirection="column" flexGrow={1}>
          <ProgressPanel job={jobData ?? {}} />
        </Box>
        <Box flexDirection="column" width={40}>
          <SchemaPanel schema={schemaData} />
          <EntityPreview entities={entityPreviews} />
        </Box>
      </Box>

      <KeyboardHints hints={HINTS} />
    </Box>
  );
}
```

- [ ] **Step 4: Add dashboard toggle to run.ts**

In `apps/cli/src/commands/run.ts`, add stdin raw mode and `[d]` keybinding. Add these changes after the runner is created (after the `// Step 11: Build LocalPipelineRunner` block) and before `runner.run()`:

First, add the imports at the top of the file:
```typescript
import type { DataSource } from '@spatula/core';
import { LocalDataSource } from '@spatula/core';
```

Then before `runner.run()`, add the dashboard toggle setup:

```typescript
  // Step 11b: Create DataSource for dashboard mode
  const dataSource: DataSource = new LocalDataSource(adapter);

  // Step 11c: Set up stdin raw mode for keyboard shortcuts during run
  let dashboardActive = false;
  let dashboardUnmount: (() => void) | null = null;
  let suppressProgress = false;

  const setupStdinRawMode = () => {
    if (!process.stdin.isTTY) return;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', handleKeypress);
  };

  const teardownStdinRawMode = () => {
    process.stdin.removeListener('data', handleKeypress);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
  };

  const handleKeypress = async (key: string) => {
    if (key === '\x03') { // Ctrl+C
      handleSigint();
      return;
    }
    if (key === 'd' || key === 'D') {
      if (dashboardActive) {
        dismissDashboard();
      } else {
        await showDashboard();
      }
    }
  };

  const showDashboard = async () => {
    dashboardActive = true;
    suppressProgress = true;
    // Remove our raw mode listener — Ink will manage stdin
    process.stdin.removeListener('data', handleKeypress);

    const React = (await import('react')).default;
    const { render: inkRender } = await import('ink');
    const { RunDashboard, buildRunDashboardStore } = await import(
      '../components/dashboard/RunDashboard.js'
    );

    const dashStore = buildRunDashboardStore(projectId);

    const { unmount } = inkRender(
      React.createElement(RunDashboard, {
        store: dashStore,
        dataSource,
        projectName,
        onDismiss: () => dismissDashboard(),
      }),
      { exitOnCtrlC: false }, // Prevent Ink from handling Ctrl+C — our SIGINT handler manages it
    );

    dashboardUnmount = unmount;
  };

  const dismissDashboard = () => {
    if (dashboardUnmount) {
      dashboardUnmount();
      dashboardUnmount = null;
    }
    dashboardActive = false;
    suppressProgress = false;
    // Re-setup our raw mode listener
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('data', handleKeypress);
    }
    console.log(''); // Clean line after dashboard
  };

  setupStdinRawMode();
  console.log('  Press [d] for dashboard view\n');
```

Update the progress listener to respect `suppressProgress`:

```typescript
  runner.events.on('progress', (stats: any) => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const pct =
      stats.totalPages > 0
        ? Math.round((stats.pagesProcessed / stats.totalPages) * 100)
        : 0;
    if (!suppressProgress) {
      process.stdout.write(
        `\r  Pages: ${stats.pagesProcessed}/${stats.totalPages} (${pct}%)` +
        `  Entities: ${stats.entitiesCreated}` +
        `  Errors: ${stats.errors}` +
        `  Elapsed: ${elapsed}s  `,
      );
    }
    logToFile('info', 'Progress', { event: 'progress', pagesProcessed: stats.pagesProcessed, totalPages: stats.totalPages, entitiesCreated: stats.entitiesCreated, errors: stats.errors, elapsed });
  });
```

In the `finally` block, add cleanup:
```typescript
  } finally {
    process.off('SIGINT', handleSigint);
    if (dashboardActive) dismissDashboard();
    teardownStdinRawMode();
    await crawler?.close().catch(() => {});
    closeDb();
  }
```

- [ ] **Step 5: Run tests**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter cli test -- --run tests/unit/commands/run-dashboard.test.ts`
Expected: All tests pass.

- [ ] **Step 6: Run full test suite**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter cli test -- --run`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/components/dashboard/RunDashboard.tsx apps/cli/src/commands/run.ts apps/cli/tests/unit/commands/run-dashboard.test.ts
git commit -m "feat(cli): add dashboard mode [d] during spatula run

Press [d] during pipeline execution to toggle a full Ink TUI dashboard
overlay showing pages, entities, schema, and errors. Dismiss with [d]
or Escape to return to compact progress line."
```

---

## Task 8: Register all new commands in index.tsx

**Files:**
- Modify: `apps/cli/src/index.tsx`

Register the 5 new commands: `explore`, `export`, `review`, `schema`, `logs`.

- [ ] **Step 1: Add command registrations**

In `apps/cli/src/index.tsx`, add the following commands after the `estimate` command and before the `new` command (to keep them grouped logically). Use dynamic imports for Ink-based commands:

```typescript
  // -------------------------------------------------------------------------
  // schema — show project schema
  // -------------------------------------------------------------------------
  .command(
    'schema',
    'Display the current project schema',
    (y) =>
      y
        .option('versions', {
          type: 'boolean',
          default: false,
          describe: 'Show version history',
        })
        .option('json', {
          type: 'boolean',
          default: false,
          describe: 'Output raw schema as JSON',
        }),
    async (argv) => {
      const { runSchemaCommand } = await import('./commands/schema.js');
      await runSchemaCommand({ versions: argv.versions, json: argv.json });
    },
  )

  // -------------------------------------------------------------------------
  // logs — view run logs
  // -------------------------------------------------------------------------
  .command(
    'logs',
    'View structured log files from spatula run',
    (y) =>
      y
        .option('run', {
          type: 'string',
          describe: 'View a specific run\'s log (by ID or filename prefix)',
        })
        .option('errors', {
          type: 'boolean',
          default: false,
          describe: 'Show only error-level entries',
        })
        .option('tail', {
          type: 'boolean',
          default: false,
          describe: 'Follow mode — print new log entries as they appear',
        }),
    async (argv) => {
      const { runLogsCommand } = await import('./commands/logs.js');
      await runLogsCommand({ run: argv.run, errors: argv.errors, tail: argv.tail });
    },
  )

  // -------------------------------------------------------------------------
  // export — export entities to file
  // -------------------------------------------------------------------------
  .command(
    'export',
    'Export entities to a file',
    (y) =>
      y
        .option('format', {
          type: 'string',
          choices: ['json', 'csv', 'sqlite', 'parquet', 'duckdb'] as const,
          default: 'json',
          describe: 'Export format',
        })
        .option('output', {
          type: 'string',
          describe: 'Output file path (default: .spatula/exports/<timestamp>.<format>)',
        })
        .option('include-provenance', {
          type: 'boolean',
          default: false,
          describe: 'Include provenance data (JSON only)',
        })
        .option('min-quality', {
          type: 'number',
          describe: 'Minimum quality score filter (0-1)',
        }),
    async (argv) => {
      const { runExportCommand } = await import('./commands/export.js');
      await runExportCommand({
        format: argv.format,
        output: argv.output,
        includeProvenance: argv.includeProvenance,
        minQuality: argv.minQuality,
      });
    },
  )

  // -------------------------------------------------------------------------
  // explore — entity browser TUI
  // -------------------------------------------------------------------------
  .command(
    'explore',
    'Browse and filter extracted entities',
    () => {},
    async () => {
      const { runExploreCommand } = await import('./commands/explore.js');
      await runExploreCommand();
    },
  )

  // -------------------------------------------------------------------------
  // review — action review TUI
  // -------------------------------------------------------------------------
  .command(
    'review',
    'Review pending schema actions',
    () => {},
    async () => {
      const { runReviewCommand } = await import('./commands/review.js');
      await runReviewCommand();
    },
  )
```

Also update the doc comment at the top of the file to include the new commands:

```typescript
/**
 * Spatula CLI — AI-powered intelligent web crawling.
 *
 * Commands:
 *   init      Initialise a new Spatula project in the current directory
 *   new       Launch interactive conversational mode to configure a crawl
 *   run       Run the local crawl pipeline for the current project
 *   status    Show local project status or remote job details
 *   add       Add seed URLs to spatula.yaml
 *   config    Open spatula.yaml in your editor
 *   setup     Configure global settings (~/.spatula/config.yaml)
 *   estimate  Estimate the LLM cost for the current project
 *   doctor    Run system health checks
 *   schema    Display the current project schema
 *   logs      View structured log files from spatula run
 *   export    Export entities to a file
 *   explore   Browse and filter extracted entities
 *   review    Review pending schema actions
 *   reset     Reset the .spatula/ working directory
 *   test      Test extraction on a single page
 *   list      (deprecated) List remote crawl jobs
 */
```

- [ ] **Step 2: Run full test suite**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter cli test -- --run`
Expected: All tests pass.

- [ ] **Step 3: Verify CLI help output**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter cli exec -- spatula --help`
Expected: All 5 new commands appear in the help output.

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/index.tsx
git commit -m "feat(cli): register explore, export, review, schema, logs commands

All Wave 4-3 data commands registered with yargs. Dynamic imports used
for Ink-based commands (explore, review) to keep CLI startup fast."
```

---

## Task 9: Final integration test and cleanup

- [ ] **Step 1: Run full CLI test suite**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter cli test -- --run`
Expected: All tests pass (344 existing + ~15 new ≈ 360+ tests).

- [ ] **Step 2: Run full monorepo test suite**

Run: `cd /Users/salar/Projects/spatula && pnpm test -- --run`
Expected: All tests across all packages pass.

- [ ] **Step 3: Type check**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter cli exec -- tsc --noEmit`
Expected: No type errors.

- [ ] **Step 4: Lint check**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter cli lint`
Expected: No lint errors.

- [ ] **Step 5: Final commit with any fixes**

If any fixes were needed, commit them:
```bash
git add -A
git commit -m "fix: address Wave 4-3 integration issues"
```
