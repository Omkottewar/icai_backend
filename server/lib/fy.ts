/**
 * Indian Financial Year (Apr 1 – Mar 31) covering `now`.
 * Returns label + UTC range so callers can filter `issued_at >= start AND < end`.
 */
export function currentFy(now = new Date()) {
  const month = now.getUTCMonth();
  const year = now.getUTCFullYear();
  const startYear = month >= 3 ? year : year - 1;
  const endYear = startYear + 1;
  return {
    label: `FY ${startYear}–${String(endYear).slice(-2)}`,
    start: new Date(Date.UTC(startYear, 3, 1)),
    end: new Date(Date.UTC(endYear, 3, 1)),
  };
}
