/**
 * The Branch rail's "open this file against the merge base" seam. The
 * host's file-open path builds tabs through `newFileTab`; a request
 * parked here just before that call rides into the tab as `diffBase`
 * (and forces the Monaco diff surface, the one that honours a base
 * ref). One-shot and short-lived, so a request nobody consumed cannot
 * turn a later plain open into a review.
 */

const TTL_MS = 5000;
let pending: { path: string; base: string; at: number } | null = null;

export function requestReview(path: string, base: string): void {
  pending = { path, base, at: Date.now() };
}

/** The base ref parked for `path`, consumed once; null when none. */
export function takeReviewRequest(path: string): string | null {
  const req = pending;
  if (!req) return null;
  if (Date.now() - req.at > TTL_MS) {
    pending = null;
    return null;
  }
  if (req.path !== path && !path.endsWith(req.path)) return null;
  pending = null;
  return req.base;
}

/** Test hook. */
export function clearReviewRequest(): void {
  pending = null;
}
