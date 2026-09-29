/**
 * Stage marks along the open path (click → session ready → pane commit →
 * deferred transcript commit → first blocks) and the switch marks the
 * stall recorder times (`tab-switch`, `page-switch`). They cost nothing
 * in production and let a CDP script read where an open spent its time
 * (`performance.getEntriesByType("mark")` filtered on the `tc:` prefix).
 */
const listeners = new Set<(name: string, id: string | undefined) => void>();

export function perfMark(name: string, id?: string) {
  for (const listener of listeners) listener(name, id);
  if (typeof performance === "undefined" || typeof performance.mark !== "function") return;
  try {
    performance.mark(`tc:${name}`, id ? { detail: { sessionId: id } } : undefined);
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
