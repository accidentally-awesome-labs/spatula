export class Semaphore {
  private current = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) { this.current++; return; }
    return new Promise<void>((resolve) => { this.waiting.push(() => { this.current++; resolve(); }); });
  }

  release(): void {
    this.current--;
    const next = this.waiting.shift();
    if (next) next();
  }

  get available(): number { return this.max - this.current; }
  get activeCount(): number { return this.current; }
}
