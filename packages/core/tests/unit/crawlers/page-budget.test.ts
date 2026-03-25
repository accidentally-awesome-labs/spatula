// packages/core/tests/unit/crawlers/page-budget.test.ts
import { describe, it, expect } from 'vitest';
import { InMemoryPageBudget } from '../../../src/crawlers/page-budget.js';

describe('InMemoryPageBudget', () => {
  it('allows pages within budget', () => {
    const counter = new InMemoryPageBudget(5);
    expect(counter.tryIncrement()).toBe(true);
    expect(counter.tryIncrement()).toBe(true);
    expect(counter.count).toBe(2);
  });

  it('rejects pages exceeding budget', () => {
    const counter = new InMemoryPageBudget(3);
    expect(counter.tryIncrement()).toBe(true);
    expect(counter.tryIncrement()).toBe(true);
    expect(counter.tryIncrement()).toBe(true);
    expect(counter.tryIncrement()).toBe(false); // 4th page rejected
    expect(counter.count).toBe(3);
  });

  it('reports remaining budget', () => {
    const counter = new InMemoryPageBudget(10);
    counter.tryIncrement();
    counter.tryIncrement();
    expect(counter.remaining).toBe(8);
  });

  it('reports whether budget is exhausted', () => {
    const counter = new InMemoryPageBudget(2);
    expect(counter.isExhausted).toBe(false);
    counter.tryIncrement();
    counter.tryIncrement();
    expect(counter.isExhausted).toBe(true);
  });

  it('handles maxPages of 1', () => {
    const counter = new InMemoryPageBudget(1);
    expect(counter.tryIncrement()).toBe(true);
    expect(counter.tryIncrement()).toBe(false);
  });

  it('returns current count and max', () => {
    const counter = new InMemoryPageBudget(100);
    expect(counter.count).toBe(0);
    expect(counter.maxPages).toBe(100);
  });

  it('rejects all pages when maxPages is 0', () => {
    const counter = new InMemoryPageBudget(0);
    expect(counter.tryIncrement()).toBe(false);
    expect(counter.count).toBe(0);
    expect(counter.remaining).toBe(0);
    expect(counter.isExhausted).toBe(true);
  });
});
