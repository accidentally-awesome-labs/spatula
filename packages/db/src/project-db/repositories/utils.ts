import { StorageError } from '@spatula/shared';

export function wrapStorageError<T>(operation: () => T, context: Record<string, unknown>): T {
  try {
    return operation();
  } catch (error) {
    throw new StorageError(
      `Database operation failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error as Error, context },
    );
  }
}
