import { useEffect, useState } from "react";

/**
 * When a list should glide. Layout projection (framer's `layout` and
 * `layoutId`) measures every animated row before and after each commit,
 * and a wholesale swap, a project switch replacing every chip, pays for
 * exit springs, enter springs and a stale shared-element glide nobody
 * sees. Rows glide only once the list has settled, and never past a size
 * where measuring them costs more than the motion is worth.
 */

export const GLIDE_MAX_ROWS = 40;
/** How long after a wholesale swap the list stays still. */
export const SETTLE_MS = 400;

export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** True when fewer than half of `next` was already in `prev`. */
export function swappedWholesale(prev: readonly string[], next: readonly string[]): boolean {
  if (next.length === 0) return false;
  if (prev.length === 0) return true;
  const seen = new Set(prev);
  let kept = 0;
  for (const id of next) if (seen.has(id)) kept++;
  return kept * 2 < next.length;
}

type Glide = { ids: readonly string[]; generation: number; settled: boolean };

/**
 * `generation` bumps on every wholesale swap; key the list's presence
 * boundary on it so the old rows unmount with no exit animation and the
 * new ones mount with no enter animation. `glide` is false in the swap
 * render and until the list has settled, and always false past
 * GLIDE_MAX_ROWS.
 */
export function useListGlide(ids: readonly string[]): { generation: number; glide: boolean } {
  const [state, setState] = useState<Glide>({ ids, generation: 0, settled: true });
  if (!sameIds(state.ids, ids)) {
    // Render-phase update: React re-renders at once with the new state, so
    // an interrupted render can't lose the bump the way a ref would.
    const swapped = swappedWholesale(state.ids, ids);
    setState({
      ids,
      generation: swapped ? state.generation + 1 : state.generation,
      settled: swapped ? false : state.settled,
    });
  }
  const { generation, settled } = state;
  useEffect(() => {
    if (settled) return;
    const timer = setTimeout(
      () => setState((s) => (s.generation === generation ? { ...s, settled: true } : s)),
      SETTLE_MS,
    );
    return () => clearTimeout(timer);
  }, [generation, settled]);
  return { generation, glide: settled && ids.length <= GLIDE_MAX_ROWS };
}
