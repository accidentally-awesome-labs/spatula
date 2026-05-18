import { describe, it, expect } from 'vitest';
import { PriorityQueue } from '../../../src/pipeline/priority-queue.js';

describe('PriorityQueue', () => {
  it('dequeues highest priority first', () => {
    const q = new PriorityQueue<string>();
    q.enqueue('low', 1, 0);
    q.enqueue('high', 10, 0);
    q.enqueue('medium', 5, 0);
    expect(q.dequeue()).toBe('high');
    expect(q.dequeue()).toBe('medium');
    expect(q.dequeue()).toBe('low');
  });

  it('breaks ties by depth (breadth-first)', () => {
    const q = new PriorityQueue<string>();
    q.enqueue('deep', 5, 3);
    q.enqueue('shallow', 5, 1);
    q.enqueue('mid', 5, 2);
    expect(q.dequeue()).toBe('shallow');
  });

  it('dequeueBatch returns up to N items', () => {
    const q = new PriorityQueue<number>();
    q.enqueue(1, 1, 0);
    q.enqueue(2, 2, 0);
    q.enqueue(3, 3, 0);
    expect(q.dequeueBatch(2)).toEqual([3, 2]);
    expect(q.size).toBe(1);
  });

  it('reports size and isEmpty', () => {
    const q = new PriorityQueue<string>();
    expect(q.isEmpty).toBe(true);
    q.enqueue('a', 1, 0);
    expect(q.isEmpty).toBe(false);
    expect(q.size).toBe(1);
  });
});
