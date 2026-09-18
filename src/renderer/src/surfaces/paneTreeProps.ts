/**
 * `PaneTree`'s memo comparator. A hidden tree renders for nothing App does:
 * it catches up when it shows. A visible one re-renders only when a prop
 * changed; the tab record and the editors' state reach it through the
 * stores, not through App, so the remaining props are flags and handlers.
 */
export function paneTreePropsEqual<T extends { visible: boolean }>(previous: T, next: T): boolean {
  if (!previous.visible && !next.visible) return true;
  const keys = Object.keys(next) as (keyof T)[];
  if (keys.length !== Object.keys(previous).length) return false;
  return keys.every((key) => previous[key] === next[key]);
}

/**
 * The same "a hidden tree does nothing" rule for a value a leaf reads
 * straight from a store, bypassing `paneTreePropsEqual` entirely: a parked
 * `SessionLeaf` still subscribes to its own session directly, so a busy
 * thread would otherwise hand `SessionPane` a fresh object on every
 * streamed token and force it to reconcile a transcript nobody can see.
 * Held to `frozen` (the last value read while visible) until `visible`
 * flips back on, at which point the live value shows at once. A leaf
 * that has never been visible yet has nothing frozen to hold, so it
 * reads live until it does.
 */
export function holdWhileHidden<T>(visible: boolean, live: T, frozen: T | undefined): T {
  return visible || frozen === undefined ? live : frozen;
}
