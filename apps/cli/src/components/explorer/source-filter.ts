export type SourceFilter = 'all' | 'local' | 'remote';

const CYCLE: SourceFilter[] = ['all', 'local', 'remote'];

export function cycleSourceFilter(current: SourceFilter): SourceFilter {
  const idx = CYCLE.indexOf(current);
  return CYCLE[(idx + 1) % CYCLE.length];
}

export function sourceFilterLabel(filter: SourceFilter): string {
  return filter.charAt(0).toUpperCase() + filter.slice(1);
}
