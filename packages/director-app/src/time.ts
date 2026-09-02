// The ONE reading of a Calliope timestamp.
//
// SQLite's `CURRENT_TIMESTAMP` is ZONELESS — Calliope sends "2026-09-01 10:00:00", and rows a
// store patched carry an ISO "2026-09-01T10:00:00" with no `Z`. Both are UTC, and `Date.parse`
// reads the first as LOCAL time and skews every "3m ago" by the zone offset. So a stamp with a
// time component and no zone is pinned to UTC; anything already carrying one is left alone.
//
// Three modules grew their own copy of this (the job strip, the queue panel and the render
// history drawer) and they have to agree: the same job's stamp is compared across all three,
// and two readings of one string sort a "just finished" job above a running one.

const ZONED = /(?:Z|z|[+-]\d{2}:?\d{2})$/;
const HAS_TIME = /\d{1,2}:\d{2}/;

/** ms since epoch, or null when there is no stamp or it is not one. */
export function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const s = value.trim();
  if (!s) return null;
  // A DATE with no time is already UTC by the spec, so appending a zone would only break it.
  const normalised = ZONED.test(s) || !HAS_TIME.test(s) ? s : `${s.replace(" ", "T")}Z`;
  const t = Date.parse(normalised);
  return Number.isNaN(t) ? null : t;
}

/** The same reading, as the NaN-for-nothing number `render-state`'s callers test with. */
export const parseTimeMs = (value: string | null | undefined): number => parseTime(value) ?? Number.NaN;
