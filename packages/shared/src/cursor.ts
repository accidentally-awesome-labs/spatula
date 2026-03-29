import { ValidationError } from './errors.js';

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
    return parsed as CursorPayload;
  } catch {
    throw new ValidationError('Invalid cursor format');
  }
}
