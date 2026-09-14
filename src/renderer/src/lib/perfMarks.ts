/**
 * Stage marks along the open path (click → session ready → pane commit →
 * deferred transcript commit → first blocks). They cost nothing in
 * production and let a CDP script read where an open spent its time
 * (`performance.getEntriesByType("mark")` filtered on the `tc:` prefix).
 */
export function perfMark(name: string, sessionId?: string) {
  if (typeof performance === "undefined" || typeof performance.mark !== "function") return;
  try {
    performance.mark(`tc:${name}`, sessionId ? { detail: { sessionId } } : undefined);
  } catch {
    // an old runtime without mark options
  }
}
