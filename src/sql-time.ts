/**
 * Canonical SQL clock for UTC RFC 3339 timestamps produced by
 * `validDateTime()` and external provider projections.
 *
 * SQLite's `datetime('now')` uses `YYYY-MM-DD HH:MM:SS`, which must not be
 * compared as TEXT with `YYYY-MM-DDTHH:MM:SS.sssZ`. Keeping the clock in the
 * same fixed-width format preserves chronological TEXT ordering, millisecond
 * precision, and indexes on stored timestamp columns.
 */
export const SQL_UTC_NOW_RFC3339 =
  "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
