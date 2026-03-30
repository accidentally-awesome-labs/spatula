export interface QueueItem<T> { data: T; priority: number; depth: number; }

export class PriorityQueue<T> {
  private items: QueueItem<T>[] = [];

  enqueue(data: T, priority: number, depth: number): void {
    this.items.push({ data, priority, depth });
    this.items.sort((a, b) => b.priority !== a.priority ? b.priority - a.priority : a.depth - b.depth);
  }

  dequeue(): T | undefined { return this.items.shift()?.data; }

  dequeueBatch(count: number): T[] {
    const batch: T[] = [];
    for (let i = 0; i < count; i++) { const item = this.dequeue(); if (!item) break; batch.push(item); }
    return batch;
  }

  get size(): number { return this.items.length; }
  get isEmpty(): boolean { return this.items.length === 0; }
}
