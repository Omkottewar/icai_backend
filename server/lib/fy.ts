/**
 * Indian Financial Year (Apr 1 - Mar 31) covering `now`.
 * Returns label + UTC range so callers can filter `issued_at >= start AND < end`.
 *
 * Label uses an ASCII hyphen ("FY 2026-27") rather than the typographic
 * en-dash. An earlier version embedded U+2013 directly and rendered as
 * mojibake in some browsers due to a Latin-1 / UTF-8 mismatch in the
 * toolchain. The hyphen costs nothing visually and avoids the class of bug.
 */
export function currentFy(now = new Date()) {
  const month = now.getUTCMonth();
  const year = now.getUTCFullYear();
  const startYear = month >= 3 ? year : year - 1;
  const endYear = startYear + 1;
  return {
    label: `FY ${startYear}-${String(endYear).slice(-2)}`,
    start: new Date(Date.UTC(startYear, 3, 1)),
    end: new Date(Date.UTC(endYear, 3, 1)),
  };
}
