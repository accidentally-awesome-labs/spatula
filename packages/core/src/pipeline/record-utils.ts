export function isMeaningfulValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;

  if (typeof value === 'string') {
    return value.trim().length > 0;
  }

  if (Array.isArray(value)) {
    return value.some(isMeaningfulValue);
  }

  if (typeof value === 'object') {
    return isMeaningfulRecord(value);
  }

  return true;
}

export function isMeaningfulRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).some(isMeaningfulValue);
}

export function getEntityData(entity: unknown): Record<string, unknown> | null {
  if (!entity || typeof entity !== 'object' || Array.isArray(entity)) return null;
  const record = entity as Record<string, unknown>;
  const data = record['mergedData'] ?? record;
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : null;
}

export function isMeaningfulEntity(entity: unknown): boolean {
  return isMeaningfulRecord(getEntityData(entity));
}
