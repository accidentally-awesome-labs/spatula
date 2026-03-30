import { describe, it, expect } from 'vitest';
import { Semaphore } from '../../../src/pipeline/concurrency.js';

describe('Semaphore', () => {
  it('allows up to max concurrent', async () => {
    const sem = new Semaphore(2);
    await sem.acquire(); await sem.acquire();
    expect(sem.activeCount).toBe(2);
    expect(sem.available).toBe(0);
    sem.release(); sem.release();
  });

  it('blocks beyond max and resumes on release', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();
    let resolved = false;
    const pending = sem.acquire().then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);
    sem.release();
    await pending;
    expect(resolved).toBe(true);
    sem.release();
  });

  it('reports available slots', async () => {
    const sem = new Semaphore(3);
    expect(sem.available).toBe(3);
    await sem.acquire();
    expect(sem.available).toBe(2);
    sem.release();
    expect(sem.available).toBe(3);
  });
});
