import { describe, expect, it } from 'vitest';
import {
  MAX_INTERVAL_FACTOR,
  REFUSE_AFTER_RUNS,
  siteAnswer,
  sourceIntervalMs,
  sourceVerdict,
} from './refusals';

describe('siteAnswer', () => {
  it.each([
    [200, 'through'],
    [304, 'through'],
    [301, 'through'],
    [404, 'through'],
    [410, 'through'],
    [400, 'through'],
  ] as const)('reads %i as getting through: the site answered', (status, expected) => {
    expect(siteAnswer({ status, challenge: false })).toBe(expected);
  });

  it.each([401, 402, 403, 429])('reads %i as a refusal', (status) => {
    expect(siteAnswer({ status, challenge: false })).toBe('refused');
  });

  it('reads a challenge as a refusal, whatever its status', () => {
    expect(siteAnswer({ status: 403, challenge: true })).toBe('refused');
    expect(siteAnswer({ status: 200, challenge: true })).toBe('refused');
  });

  it('reads an outage, and no answer, as neither', () => {
    expect(siteAnswer({ status: 500, challenge: false })).toBeNull();
    expect(siteAnswer({ status: 503, challenge: false })).toBeNull();
    expect(siteAnswer({ status: null, challenge: false })).toBeNull();
  });

  it('reads an answer that says nothing of its own as a refusal when robots.txt refused', () => {
    // No answer, as when the gate held the request back, and an outage.
    expect(siteAnswer({ status: null, challenge: false, robotsRefused: true })).toBe('refused');
    expect(siteAnswer({ status: 503, challenge: false, robotsRefused: true })).toBe('refused');
    expect(siteAnswer({ status: null, challenge: false, robotsRefused: false })).toBeNull();
    expect(siteAnswer({ status: 503, challenge: false, robotsRefused: false })).toBeNull();
  });

  it('leaves an answer its own verdict when robots.txt refused: it can only add a refusal', () => {
    expect(siteAnswer({ status: 200, challenge: false, robotsRefused: true })).toBe('through');
    expect(siteAnswer({ status: 404, challenge: false, robotsRefused: true })).toBe('through');
    expect(siteAnswer({ status: 429, challenge: false, robotsRefused: true })).toBe('refused');
    expect(siteAnswer({ status: 200, challenge: true, robotsRefused: true })).toBe('refused');
  });
});

describe('sourceVerdict', () => {
  it('is through when anything got through, however much refused', () => {
    expect(sourceVerdict(['refused', 'through', 'refused'])).toBe('through');
  });

  it('is blocked when nothing got through and something refused', () => {
    expect(sourceVerdict(['refused'])).toBe('blocked');
    expect(sourceVerdict([null, 'refused', undefined])).toBe('blocked');
  });

  it('is untouched when nothing was asked, or nothing answered either way', () => {
    expect(sourceVerdict([])).toBe('untouched');
    expect(sourceVerdict([null, undefined])).toBe('untouched');
  });
});

describe('sourceIntervalMs', () => {
  it('doubles the interval with each blocked run in a row, up to four times', () => {
    expect(REFUSE_AFTER_RUNS).toBe(3);
    expect(MAX_INTERVAL_FACTOR).toBe(4);
    expect([0, 1, 2, 3, 7].map((runs) => sourceIntervalMs(15_000, runs))).toEqual([
      15_000, 30_000, 60_000, 60_000, 60_000,
    ]);
  });
});
