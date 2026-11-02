import { useState } from "react";

/**
 * `next`, or the value this hook returned before while `same` says the two
 * read alike: a model rebuilt on every push keeps its identity until what it
 * holds changes, so the memoized components it feeds skip the push.
 */
export function useKept<T>(next: T, same: (kept: T, next: T) => boolean): T {
  const [kept, setKept] = useState(next);
  if (kept === next) return kept;
  if (same(kept, next)) return kept;
  setKept(next);
  return next;
}

/** Two sets with the same members. */
export function sameSet<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** Plain data that reads the same: arrays and plain objects member by
 *  member, anything else (a function, a Set, a Map, a class) by identity. */
export function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameData(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b) || Object.getPrototypeOf(a) !== Object.prototype || Object.getPrototypeOf(b) !== Object.prototype) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!sameData((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}
