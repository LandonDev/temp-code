/**
 * Stage marks along the open path (click → session ready → pane commit →
 * deferred transcript commit → first blocks) and the switch marks the
 * stall recorder times (`tab-switch`, `page-switch`). At most 200 remain
 * on the timeline so a CDP script can read where an open spent its time
 * (`performance.getEntriesByType("mark")` filtered on the `tc:` prefix).
 */
const markNames = new Map<string, number>();
let markCount = 0;
const listeners = new Set<(name: string, id: string | undefined) => void>();

export function perfMark(name: string, id?: string) {
  for (const listener of listeners) listener(name, id);
  if (typeof performance === "undefined" || typeof performance.mark !== "function") return;
  try {
    const key = `tc:${name}`;
    performance.mark(key, id ? { detail: { sessionId: id } } : undefined);
    markNames.set(key, (markNames.get(key) ?? 0) + 1);
    markCount++;
    // clearMarks removes every occurrence of a name, including newer ones.
    while (markCount > 200) {
      const oldest = markNames.keys().next().value!;
      performance.clearMarks(oldest);
      markCount -= markNames.get(oldest)!;
      markNames.delete(oldest);
    }
  } catch {
    // an old runtime without mark options
  }
}

/** Hears every mark as it is placed; the stall recorder times the switch ones. */
export function onPerfMark(listener: (name: string, id: string | undefined) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
