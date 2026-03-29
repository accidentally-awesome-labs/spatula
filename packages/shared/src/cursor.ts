import { ValidationError } from './errors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CursorPayload {
  id: string;
  sortValue?: string | number;
}

export function encodeCursor(payload: CursorPayload): string {
  const json = JSON.stringify(payload);
  return Buffer.from(json).toString('base64url');
}

export function decodeCursor(cursor: string): CursorPayload {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf-8');
    const parsed = JSON.parse(json);
    if (!parsed.id || typeof parsed.id !== 'string') {
      throw new Error('Invalid cursor: missing id');
    }
    if (!UUID_RE.test(parsed.id)) {
      throw new Error('Invalid cursor: id must be a UUID');
    }
    return parsed as CursorPayload;
  } catch {
    throw new ValidationError('Invalid cursor format');
  }
}
