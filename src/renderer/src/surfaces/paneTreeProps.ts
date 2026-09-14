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
