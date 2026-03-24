// packages/core/src/crawlers/page-budget.ts

/**
 * Page budget strategy interface.
 * Server mode: implement with Redis INCR for multi-worker atomicity.
 * Local mode: use InMemoryPageBudget below.
 */
export interface PageBudget {
  tryIncrement(): Promise<boolean> | boolean;
  get count(): number;
  get remaining(): number;
  get isExhausted(): boolean;
  get maxPages(): number;
}

/**
 * In-memory page budget counter for single-process local mode.
 * For server mode with multiple workers, implement PageBudget with Redis INCR.
 */
export class InMemoryPageBudget implements PageBudget {
  private _count = 0;
  readonly maxPages: number;

  constructor(maxPages: number) {
    this.maxPages = maxPages;
  }

  /**
   * Try to increment the page count.
   * Returns true if within budget (page allowed), false if budget exhausted.
   */
  tryIncrement(): boolean {
    if (this._count >= this.maxPages) return false;
    this._count++;
    return true;
  }

  get count(): number {
    return this._count;
  }

  get remaining(): number {
    return Math.max(0, this.maxPages - this._count);
  }

  get isExhausted(): boolean {
    return this._count >= this.maxPages;
  }
}
