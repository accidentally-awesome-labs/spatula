/**
 * Worker selection utilities for parsing the SPATULA_WORKERS environment variable
 * and determining which workers should be started.
 */

/**
 * Parse the SPATULA_WORKERS environment variable into a normalized list.
 * Returns `['all']` when the variable is unset or empty.
 */
export function parseEnabledWorkers(envValue?: string): string[] {
  return (envValue ?? 'all')
    .split(',')
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length > 0);
}

/**
 * Check if a specific worker name is enabled given the parsed list.
 * The special value 'all' enables every worker.
 */
export function isWorkerEnabled(enabledList: string[], workerName: string): boolean {
  return enabledList.includes('all') || enabledList.includes(workerName);
}
