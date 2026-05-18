/**
 * `spatula logs` — view structured log files from `.spatula/logs/`.
 *
 * Reads ndjson `.log` files produced by `spatula run` and displays
 * them in a human-friendly format with ANSI colours.
 *
 * Flags:
 *   --run <id>   Find a log by filename prefix or runId within entries
 *   --errors     Show only `level === 'error'` entries
 *   --tail       Follow mode — watch for new entries (requires TTY)
 */

import { readdirSync, readFileSync, watch } from 'node:fs';
import { join } from 'node:path';
import { findProjectRoot } from '@spatula/core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LogEntry {
  level: string;
  msg: string;
  ts: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Parse a single ndjson line into a LogEntry, or null if invalid.
 */
export function parseLogEntry(line: string): LogEntry | null {
  try {
    const obj = JSON.parse(line);
    if (typeof obj === 'object' && obj !== null && typeof obj.ts === 'string') {
      return obj as LogEntry;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Format a log entry for terminal display.
 *
 * Format: `HH:MM:SS LEVEL message  key=value key=value`
 *
 * ANSI colours: error=red, warn=yellow, info=cyan, debug=gray.
 */
export function formatLogEntry(entry: LogEntry): string {
  // Extract time portion (HH:MM:SS) from ISO timestamp
  const time = entry.ts.slice(11, 19);

  const levelUpper = entry.level.toUpperCase();
  const coloredLevel = colorize(levelUpper, entry.level);

  // Collect extra fields (everything except level, msg, ts)
  const extras: string[] = [];
  const displayMap: Record<string, string> = {
    pagesProcessed: 'pages',
    entitiesCreated: 'entities',
    totalPages: 'totalPages',
  };

  for (const [key, value] of Object.entries(entry)) {
    if (key === 'level' || key === 'msg' || key === 'ts') continue;
    const displayKey = displayMap[key] ?? key;
    extras.push(`${displayKey}=${value}`);
  }

  const extraStr = extras.length > 0 ? `  ${extras.join(' ')}` : '';
  return `${time} ${coloredLevel} ${entry.msg}${extraStr}`;
}

/**
 * Filter log entries by level.
 */
export function filterByLevel(entries: LogEntry[], level: string): LogEntry[] {
  return entries.filter((e) => e.level === level);
}

/**
 * List log files in the logs directory, sorted by filename descending (newest first).
 * Returns absolute paths. Returns empty array if the directory does not exist.
 */
export function listLogFiles(logsDir: string): string[] {
  try {
    const files = readdirSync(logsDir)
      .filter((f) => f.endsWith('.log'))
      .sort()
      .reverse();
    return files.map((f) => join(logsDir, f));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// ANSI colour helpers
// ---------------------------------------------------------------------------

const ANSI = {
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  reset: '\x1b[0m',
} as const;

function colorize(text: string, level: string): string {
  switch (level) {
    case 'error':
      return `${ANSI.red}${text}${ANSI.reset}`;
    case 'warn':
      return `${ANSI.yellow}${text}${ANSI.reset}`;
    case 'info':
      return `${ANSI.cyan}${text}${ANSI.reset}`;
    case 'debug':
      return `${ANSI.gray}${text}${ANSI.reset}`;
    default:
      return text;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers (exported for testing)
// ---------------------------------------------------------------------------

export function readAndParseLog(filePath: string): LogEntry[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(Boolean);
  const entries: LogEntry[] = [];
  for (const line of lines) {
    const entry = parseLogEntry(line);
    if (entry) entries.push(entry);
  }
  return entries;
}

export function findLogFile(logsDir: string, runId: string): string | null {
  const files = listLogFiles(logsDir);

  // 1. Try matching by filename prefix
  for (const f of files) {
    const base = f.split('/').pop() ?? '';
    if (base.startsWith(runId)) return f;
  }

  // 2. Search inside log entries for a matching runId field
  for (const f of files) {
    try {
      const content = readFileSync(f, 'utf-8');
      if (content.includes(runId)) return f;
    } catch {
      /* skip unreadable files */
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public command
// ---------------------------------------------------------------------------

export interface LogsOptions {
  run?: string;
  errors?: boolean;
  tail?: boolean;
}

export async function runLogsCommand(options: LogsOptions = {}): Promise<void> {
  const cwd = process.cwd();
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) {
    console.error('Error: no spatula.yaml found. Run `spatula init` to create a project here.');
    process.exit(1);
  }

  const logsDir = join(projectRoot, '.spatula', 'logs');
  let logFile: string | null = null;

  if (options.run) {
    logFile = findLogFile(logsDir, options.run);
    if (!logFile) {
      console.error(`Error: no log file found matching "${options.run}".`);
      process.exit(1);
    }
  } else {
    const files = listLogFiles(logsDir);
    if (files.length === 0) {
      console.error('No log files found in .spatula/logs/.');
      process.exit(1);
    }
    logFile = files[0]; // newest first
  }

  // Read and display
  let entries = readAndParseLog(logFile);
  if (options.errors) {
    entries = filterByLevel(entries, 'error');
  }

  for (const entry of entries) {
    console.log(formatLogEntry(entry));
  }

  // Tail mode: watch for new lines appended to the file
  if (options.tail) {
    if (!process.stdout.isTTY) {
      console.error('Error: --tail requires an interactive terminal (TTY).');
      process.exit(1);
    }

    let offset = readFileSync(logFile, 'utf-8').length;
    console.log('\n-- following (Ctrl+C to stop) --\n');

    const watcher = watch(logFile, () => {
      try {
        const content = readFileSync(logFile!, 'utf-8');
        const newContent = content.slice(offset);
        offset = content.length;

        if (newContent) {
          const newLines = newContent.split('\n').filter(Boolean);
          for (const line of newLines) {
            const entry = parseLogEntry(line);
            if (!entry) continue;
            if (options.errors && entry.level !== 'error') continue;
            console.log(formatLogEntry(entry));
          }
        }
      } catch {
        /* non-fatal */
      }
    });

    // Keep alive until SIGINT — use once() to avoid listener leak
    await new Promise<void>((resolve) => {
      process.once('SIGINT', () => {
        watcher.close();
        resolve();
      });
    });
  }
}
