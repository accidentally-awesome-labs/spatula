import { describe, it, expect } from 'vitest';
import { parseLogEntry, formatLogEntry, filterByLevel, listLogFiles } from '../../../src/commands/logs.js';
import type { LogEntry } from '../../../src/commands/logs.js';

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
  });
});
