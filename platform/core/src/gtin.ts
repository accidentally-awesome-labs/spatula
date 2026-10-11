/*
 * GTINs: the numbers under barcodes. A UPC-A has 12 digits, an EAN-13 13, an EAN-8 8, and a
 * GTIN-14 14. Spatula keeps each as 14 digits, padded with zeros in front, as GS1 compares them,
 * so a UPC and the EAN-13 a store prints for the same product are one GTIN. Ported from Crowdio's
 * packages/core/src/gtin.ts, so both sides normalize alike.
 */

const LENGTHS = new Set([8, 12, 13, 14]);

/** Whether the last digit is the GS1 check digit for the others. */
function hasValidCheckDigit(digits: string): boolean {
  let sum = 0;
  // From the right, leaving out the check digit, the weights alternate 3, 1, 3, …
  for (let index = digits.length - 2, weight = 3; index >= 0; index -= 1, weight = 4 - weight) {
    sum += Number(digits[index]) * weight;
  }
  return (10 - (sum % 10)) % 10 === Number(digits.at(-1));
}

/**
 * A GTIN as 14 digits. Spaces and hyphens are ignored. Returns `null` for anything but a GTIN-8,
 * -12, -13, or -14 with a valid check digit. All zeros passes the check digit but names no
 * product, so it's refused too.
 */
export function normalizeGtin(input: string): string | null {
  const digits = input.replace(/[\s-]/gu, '');
  if (!/^\d+$/u.test(digits) || !LENGTHS.has(digits.length) || /^0+$/u.test(digits)) return null;
  return hasValidCheckDigit(digits) ? digits.padStart(14, '0') : null;
}
