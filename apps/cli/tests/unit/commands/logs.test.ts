import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseLogEntry,
  formatLogEntry,
  filterByLevel,
  listLogFiles,
  readAndParseLog,
  findLogFile,
} from '../../../src/commands/logs.js';
import type { LogEntry } from '../../../src/commands/logs.js';

// ---------------------------------------------------------------------------
// Module-level mock for @spatula/core (needed by runLogsCommand)
// ---------------------------------------------------------------------------

vi.mock('@spatula/core', async () => {
  const actual = await vi.importActual<typeof import('@spatula/core')>('@spatula/core');
  return { ...actual, findProjectRoot: vi.fn() };
});

describe('spatula logs', () => {
  // -------------------------------------------------------------------------
  // parseLogEntry
  // -------------------------------------------------------------------------
  describe('parseLogEntry', () => {
    it('parses valid JSON into a LogEntry', () => {
      const line = '{"level":"info","msg":"Progress","ts":"2026-03-31T12:00:00.000Z","event":"progress"}';
      const entry = parseLogEntry(line);
      expect(entry).not.toBeNull();
      expect(entry!.level).toBe('info');
      expect(entry!.msg).toBe('Progress');
      expect(entry!.ts).toBe('2026-03-31T12:00:00.000Z');
      expect(entry!.event).toBe('progress');
    });

    it('returns null for invalid JSON', () => {
      expect(parseLogEntry('not json')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(parseLogEntry('')).toBeNull();
    });

    it('returns null for JSON without ts field', () => {
      expect(parseLogEntry('{"level":"info","msg":"hi"}')).toBeNull();
    });

    it('returns null for non-object JSON', () => {
      expect(parseLogEntry('"just a string"')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // formatLogEntry
  // -------------------------------------------------------------------------
  describe('formatLogEntry', () => {
    it('formats entry with time, level, and message', () => {
      const entry: LogEntry = { level: 'info', msg: 'Progress', ts: '2026-03-31T12:34:56.000Z' };
      const output = formatLogEntry(entry);
      expect(output).toContain('12:34:56');
      expect(output).toContain('INFO');
      expect(output).toContain('Progress');
    });

    it('includes key=value pairs for extra fields', () => {
      const entry: LogEntry = {
        level: 'info',
        msg: 'Progress',
        ts: '2026-03-31T12:00:00.000Z',
        pagesProcessed: 5,
        entitiesCreated: 10,
      };
      const output = formatLogEntry(entry);
      expect(output).toContain('pages=5');
      expect(output).toContain('entities=10');
    });

    it('uses totalPages as-is for unknown-mapped fields', () => {
      const entry: LogEntry = {
        level: 'info',
        msg: 'Progress',
        ts: '2026-03-31T12:00:00.000Z',
        totalPages: 20,
      };
      const output = formatLogEntry(entry);
      expect(output).toContain('totalPages=20');
    });

    it('applies ANSI red for error level', () => {
      const entry: LogEntry = { level: 'error', msg: 'Failed', ts: '2026-03-31T12:00:00.000Z' };
      const output = formatLogEntry(entry);
      // red escape: \x1b[31m
      expect(output).toContain('\x1b[31m');
    });

    it('applies ANSI yellow for warn level', () => {
      const entry: LogEntry = { level: 'warn', msg: 'Warning', ts: '2026-03-31T12:00:00.000Z' };
      const output = formatLogEntry(entry);
      expect(output).toContain('\x1b[33m');
    });

    it('applies ANSI cyan for info level', () => {
      const entry: LogEntry = { level: 'info', msg: 'Info', ts: '2026-03-31T12:00:00.000Z' };
      const output = formatLogEntry(entry);
      expect(output).toContain('\x1b[36m');
    });

    it('applies ANSI gray for debug level', () => {
      const entry: LogEntry = { level: 'debug', msg: 'Debug', ts: '2026-03-31T12:00:00.000Z' };
      const output = formatLogEntry(entry);
      expect(output).toContain('\x1b[90m');
    });
  });

  // -------------------------------------------------------------------------
  // filterByLevel
  // -------------------------------------------------------------------------
  describe('filterByLevel', () => {
    const entries: LogEntry[] = [
      { level: 'info', msg: 'A', ts: '2026-03-31T12:00:00.000Z' },
      { level: 'error', msg: 'B', ts: '2026-03-31T12:00:01.000Z' },
      { level: 'info', msg: 'C', ts: '2026-03-31T12:00:02.000Z' },
      { level: 'warn', msg: 'D', ts: '2026-03-31T12:00:03.000Z' },
      { level: 'error', msg: 'E', ts: '2026-03-31T12:00:04.000Z' },
    ];

    it('filters to only matching level', () => {
      const errors = filterByLevel(entries, 'error');
      expect(errors).toHaveLength(2);
      expect(errors[0].msg).toBe('B');
      expect(errors[1].msg).toBe('E');
    });

    it('returns empty array when no entries match', () => {
      const debugs = filterByLevel(entries, 'debug');
      expect(debugs).toHaveLength(0);
    });

    it('returns all entries when all match', () => {
      const infos: LogEntry[] = [
        { level: 'info', msg: 'X', ts: '2026-03-31T12:00:00.000Z' },
        { level: 'info', msg: 'Y', ts: '2026-03-31T12:00:01.000Z' },
      ];
      expect(filterByLevel(infos, 'info')).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // listLogFiles
  // -------------------------------------------------------------------------
  describe('listLogFiles', () => {
    it('returns empty array for nonexistent directory', () => {
      const result = listLogFiles('/tmp/spatula-nonexistent-dir-abc123');
      expect(result).toEqual([]);
    });

    it('returns only .log files, ignoring other extensions', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'spatula-logs-'));
      try {
        writeFileSync(join(tmpDir, '2026-03-30T10-00-00.log'), '');
        writeFileSync(join(tmpDir, '2026-03-31T10-00-00.log'), '');
        writeFileSync(join(tmpDir, 'notes.txt'), '');
        writeFileSync(join(tmpDir, 'data.json'), '');

        const result = listLogFiles(tmpDir);
        expect(result).toHaveLength(2);
        for (const f of result) {
          expect(f).toMatch(/\.log$/);
        }
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('returns files sorted newest-first (reverse alphabetical)', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'spatula-logs-'));
      try {
        writeFileSync(join(tmpDir, '2026-03-29T08-00-00.log'), '');
        writeFileSync(join(tmpDir, '2026-03-31T12-00-00.log'), '');
        writeFileSync(join(tmpDir, '2026-03-30T10-00-00.log'), '');

        const result = listLogFiles(tmpDir);
        expect(result).toHaveLength(3);
        // Newest first
        expect(result[0]).toContain('2026-03-31T12-00-00.log');
        expect(result[1]).toContain('2026-03-30T10-00-00.log');
        expect(result[2]).toContain('2026-03-29T08-00-00.log');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // -------------------------------------------------------------------------
  // readAndParseLog
  // -------------------------------------------------------------------------
  describe('readAndParseLog', () => {
    it('parses valid ndjson file into array of LogEntry objects', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'spatula-logs-'));
      const filePath = join(tmpDir, 'test.log');
      try {
        const lines = [
          JSON.stringify({ level: 'info', msg: 'Starting', ts: '2026-03-31T12:00:00.000Z' }),
          JSON.stringify({ level: 'warn', msg: 'Slow page', ts: '2026-03-31T12:00:01.000Z', url: 'https://example.com' }),
          JSON.stringify({ level: 'error', msg: 'Failed', ts: '2026-03-31T12:00:02.000Z' }),
        ];
        writeFileSync(filePath, lines.join('\n') + '\n');

        const entries = readAndParseLog(filePath);
        expect(entries).toHaveLength(3);
        expect(entries[0].level).toBe('info');
        expect(entries[0].msg).toBe('Starting');
        expect(entries[1].level).toBe('warn');
        expect(entries[1].url).toBe('https://example.com');
        expect(entries[2].level).toBe('error');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('skips invalid lines (mixed valid/invalid JSON)', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'spatula-logs-'));
      const filePath = join(tmpDir, 'mixed.log');
      try {
        const content = [
          JSON.stringify({ level: 'info', msg: 'Good', ts: '2026-03-31T12:00:00.000Z' }),
          'this is not valid json',
          '{"no_ts_field": true}',
          JSON.stringify({ level: 'error', msg: 'Also good', ts: '2026-03-31T12:00:01.000Z' }),
        ].join('\n');
        writeFileSync(filePath, content);

        const entries = readAndParseLog(filePath);
        expect(entries).toHaveLength(2);
        expect(entries[0].msg).toBe('Good');
        expect(entries[1].msg).toBe('Also good');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('returns empty array for empty file', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'spatula-logs-'));
      const filePath = join(tmpDir, 'empty.log');
      try {
        writeFileSync(filePath, '');

        const entries = readAndParseLog(filePath);
        expect(entries).toEqual([]);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // -------------------------------------------------------------------------
  // findLogFile
  // -------------------------------------------------------------------------
  describe('findLogFile', () => {
    it('finds a log file by filename prefix', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'spatula-logs-'));
      try {
        writeFileSync(join(tmpDir, '2026-03-29T08-00-00.log'), '');
        writeFileSync(join(tmpDir, '2026-03-31T12-00-00.log'), '');
        writeFileSync(join(tmpDir, '2026-03-30T10-00-00.log'), '');

        const result = findLogFile(tmpDir, '2026-03-30');
        expect(result).not.toBeNull();
        expect(result).toContain('2026-03-30T10-00-00.log');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('finds a log file by runId content search', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'spatula-logs-'));
      try {
        // First file has no matching runId
        writeFileSync(
          join(tmpDir, '2026-03-29T08-00-00.log'),
          JSON.stringify({ level: 'info', msg: 'No match', ts: '2026-03-29T08:00:00.000Z', runId: 'xyz-999' }) + '\n',
        );
        // Second file contains the target runId
        writeFileSync(
          join(tmpDir, '2026-03-30T10-00-00.log'),
          JSON.stringify({ level: 'info', msg: 'Match', ts: '2026-03-30T10:00:00.000Z', runId: 'abc-123' }) + '\n',
        );

        const result = findLogFile(tmpDir, 'abc-123');
        expect(result).not.toBeNull();
        expect(result).toContain('2026-03-30T10-00-00.log');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('returns null when no match found', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'spatula-logs-'));
      try {
        writeFileSync(
          join(tmpDir, '2026-03-29T08-00-00.log'),
          JSON.stringify({ level: 'info', msg: 'Nope', ts: '2026-03-29T08:00:00.000Z' }) + '\n',
        );

        const result = findLogFile(tmpDir, 'nonexistent-run-id');
        expect(result).toBeNull();
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('returns null for empty directory', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'spatula-logs-'));
      try {
        const result = findLogFile(tmpDir, 'anything');
        expect(result).toBeNull();
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // -------------------------------------------------------------------------
  // runLogsCommand
  // -------------------------------------------------------------------------
  describe('runLogsCommand', () => {
    let exitSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;
    let logSpy: ReturnType<typeof vi.spyOn>;
    let cwdSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null | undefined) => {
        throw new Error(`process.exit(${_code})`);
      });
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      cwdSpy = vi.spyOn(process, 'cwd');
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('exits with error when no project root is found', async () => {
      const { findProjectRoot } = await import('@spatula/core');
      (findProjectRoot as ReturnType<typeof vi.fn>).mockReturnValue(null);
      cwdSpy.mockReturnValue('/tmp/nowhere');

      const { runLogsCommand } = await import('../../../src/commands/logs.js');

      await expect(runLogsCommand()).rejects.toThrow('process.exit(1)');
      expect(exitSpy).toHaveBeenCalledWith(1);

      const errorMessages = errorSpy.mock.calls.map((args) => String(args[0])).join('\n');
      expect(errorMessages).toContain('no spatula.yaml found');
    });

    it('displays latest log file when no flags given', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'spatula-project-'));
      const logsDir = join(tmpDir, '.spatula', 'logs');
      mkdirSync(logsDir, { recursive: true });

      // Create two log files — newest should be shown
      writeFileSync(
        join(logsDir, '2026-03-30T10-00-00.log'),
        JSON.stringify({ level: 'info', msg: 'Older run', ts: '2026-03-30T10:00:00.000Z' }) + '\n',
      );
      writeFileSync(
        join(logsDir, '2026-03-31T12-00-00.log'),
        [
          JSON.stringify({ level: 'info', msg: 'Starting crawl', ts: '2026-03-31T12:00:00.000Z' }),
          JSON.stringify({ level: 'warn', msg: 'Slow page', ts: '2026-03-31T12:00:01.000Z' }),
        ].join('\n') + '\n',
      );

      try {
        const { findProjectRoot } = await import('@spatula/core');
        (findProjectRoot as ReturnType<typeof vi.fn>).mockReturnValue(tmpDir);
        cwdSpy.mockReturnValue(tmpDir);

        const { runLogsCommand } = await import('../../../src/commands/logs.js');
        await runLogsCommand();

        // Should display the two entries from the newest log file
        expect(logSpy).toHaveBeenCalledTimes(2);
        const allOutput = logSpy.mock.calls.map((args) => String(args[0])).join('\n');
        expect(allOutput).toContain('Starting crawl');
        expect(allOutput).toContain('Slow page');
        // Should NOT contain the older log file's entries
        expect(allOutput).not.toContain('Older run');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('filters to error-level only with errors option', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'spatula-project-'));
      const logsDir = join(tmpDir, '.spatula', 'logs');
      mkdirSync(logsDir, { recursive: true });

      writeFileSync(
        join(logsDir, '2026-03-31T12-00-00.log'),
        [
          JSON.stringify({ level: 'info', msg: 'Started', ts: '2026-03-31T12:00:00.000Z' }),
          JSON.stringify({ level: 'error', msg: 'Crash', ts: '2026-03-31T12:00:01.000Z' }),
          JSON.stringify({ level: 'info', msg: 'Continued', ts: '2026-03-31T12:00:02.000Z' }),
          JSON.stringify({ level: 'error', msg: 'Timeout', ts: '2026-03-31T12:00:03.000Z' }),
        ].join('\n') + '\n',
      );

      try {
        const { findProjectRoot } = await import('@spatula/core');
        (findProjectRoot as ReturnType<typeof vi.fn>).mockReturnValue(tmpDir);
        cwdSpy.mockReturnValue(tmpDir);

        const { runLogsCommand } = await import('../../../src/commands/logs.js');
        await runLogsCommand({ errors: true });

        // Should only display the 2 error entries
        expect(logSpy).toHaveBeenCalledTimes(2);
        const allOutput = logSpy.mock.calls.map((args) => String(args[0])).join('\n');
        expect(allOutput).toContain('Crash');
        expect(allOutput).toContain('Timeout');
        expect(allOutput).not.toContain('Started');
        expect(allOutput).not.toContain('Continued');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('handles --run flag to find specific log by filename prefix', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'spatula-project-'));
      const logsDir = join(tmpDir, '.spatula', 'logs');
      mkdirSync(logsDir, { recursive: true });

      writeFileSync(
        join(logsDir, '2026-03-30T10-00-00.log'),
        JSON.stringify({ level: 'info', msg: 'Target run', ts: '2026-03-30T10:00:00.000Z' }) + '\n',
      );
      writeFileSync(
        join(logsDir, '2026-03-31T12-00-00.log'),
        JSON.stringify({ level: 'info', msg: 'Latest run', ts: '2026-03-31T12:00:00.000Z' }) + '\n',
      );

      try {
        const { findProjectRoot } = await import('@spatula/core');
        (findProjectRoot as ReturnType<typeof vi.fn>).mockReturnValue(tmpDir);
        cwdSpy.mockReturnValue(tmpDir);

        const { runLogsCommand } = await import('../../../src/commands/logs.js');
        await runLogsCommand({ run: '2026-03-30' });

        expect(logSpy).toHaveBeenCalledTimes(1);
        const allOutput = logSpy.mock.calls.map((args) => String(args[0])).join('\n');
        expect(allOutput).toContain('Target run');
        expect(allOutput).not.toContain('Latest run');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('exits with error when --run finds no matching log', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'spatula-project-'));
      const logsDir = join(tmpDir, '.spatula', 'logs');
      mkdirSync(logsDir, { recursive: true });

      writeFileSync(
        join(logsDir, '2026-03-31T12-00-00.log'),
        JSON.stringify({ level: 'info', msg: 'Some run', ts: '2026-03-31T12:00:00.000Z' }) + '\n',
      );

      try {
        const { findProjectRoot } = await import('@spatula/core');
        (findProjectRoot as ReturnType<typeof vi.fn>).mockReturnValue(tmpDir);
        cwdSpy.mockReturnValue(tmpDir);

        const { runLogsCommand } = await import('../../../src/commands/logs.js');
        await expect(runLogsCommand({ run: 'nonexistent' })).rejects.toThrow('process.exit(1)');
        expect(exitSpy).toHaveBeenCalledWith(1);

        const errorMessages = errorSpy.mock.calls.map((args) => String(args[0])).join('\n');
        expect(errorMessages).toContain('no log file found matching');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('exits with error when no log files exist', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'spatula-project-'));
      const logsDir = join(tmpDir, '.spatula', 'logs');
      mkdirSync(logsDir, { recursive: true });
      // Empty logs directory — no .log files

      try {
        const { findProjectRoot } = await import('@spatula/core');
        (findProjectRoot as ReturnType<typeof vi.fn>).mockReturnValue(tmpDir);
        cwdSpy.mockReturnValue(tmpDir);

        const { runLogsCommand } = await import('../../../src/commands/logs.js');
        await expect(runLogsCommand()).rejects.toThrow('process.exit(1)');
        expect(exitSpy).toHaveBeenCalledWith(1);

        const errorMessages = errorSpy.mock.calls.map((args) => String(args[0])).join('\n');
        expect(errorMessages).toContain('No log files found');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
