/**
 * Free-text search over a name or a code.
 *
 * This exists because of a difference that does not announce itself: SQLite's `LIKE` is
 * case-insensitive for ASCII, so `{ contains: q }` matched "almirah" against "ALMIRAH"
 * for free. Postgres' `LIKE` is case-sensitive, and the same filter silently returns
 * nothing for a lower-case search over upper-case data — a search box that looks broken
 * with no error anywhere. `mode: 'insensitive'` compiles to `ILIKE` and restores the
 * behaviour the UI was built against.
 *
 * Stated once here rather than at each call site, so a new search box cannot be added
 * with the case-sensitive default by accident. Matching stays a plain substring: the
 * suggestion engine's `normalizeKey` is what collapses spacing, and fuzzy matching would
 * merge genuinely different items.
 */
export function like(q: string) {
  return { contains: q, mode: 'insensitive' } as const;
}
