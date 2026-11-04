// UI-16: which running calls a person opened from the working line.

const CAP = 200;
const opened = new Set<string>();

/**
 * Record that the person opened (or closed) a running call's body from the
 * turn's working line, by the call's block id. When the call settles and
 * lands as a row in its group, the row mounts open and counts as the
 * person's hand on that group (ActionRow). Bounded: the oldest entries go.
 */
export function setOpenedLive(id: string, open: boolean): void {
  opened.delete(id);
  if (!open) return;
  opened.add(id);
  while (opened.size > CAP) {
    const oldest = opened.values().next().value;
    if (oldest === undefined) break;
    opened.delete(oldest);
  }
}

/** Whether the person left this call's body open on the working line. */
export function openedLive(id: string): boolean {
  return opened.has(id);
}
