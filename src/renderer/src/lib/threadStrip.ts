/**
 * The title bar's thread strip, as temp-code's ThreadStrip laid it out:
 * live chips (working, needs-you, failed, unread, plan-ready) on the top
 * row, dormant ones on the shelf a line below, each row freshest activity
 * first. Being open earns nothing: a selected dormant chip stays on the
 * shelf. Archive hides a chip; nothing on the strip closes one.
 */
export type StripTab = {
  id: string;
  dormant?: boolean;
  /** Last activity on the chip's thread, for the freshest-first order. */
  updatedAt?: number;
};

export function splitStrip<T extends StripTab>(tabs: readonly T[]): { live: T[]; dorm: T[] } {
  const byActivity = (a: T, b: T) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  return {
    live: tabs.filter((tab) => !tab.dormant).sort(byActivity),
    dorm: tabs.filter((tab) => tab.dormant).sort(byActivity),
  };
}

/** Strip order for next/previous: the live row, then the shelf. */
export function stripOrder<T extends StripTab>(tabs: readonly T[]): T[] {
  const { live, dorm } = splitStrip(tabs);
  return [...live, ...dorm];
}

/** The chip that takes selection when `id` leaves the strip: its nearest
 *  neighbour in strip order, or null when it was the last one. */
export function neighbourAfterArchive<T extends StripTab>(
  tabs: readonly T[],
  id: string,
): T | null {
  const order = stripOrder(tabs);
  const at = order.findIndex((tab) => tab.id === id);
  const rest = order.filter((tab) => tab.id !== id);
  if (rest.length === 0) return null;
  return rest[Math.min(Math.max(at, 0), rest.length - 1)];
}
