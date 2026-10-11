import { compile } from 'css-select';

/** Why a CSS selector doesn't parse, or `null` when it does. */
export function selectorError(css: string): string | null {
  try {
    compile(css);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
