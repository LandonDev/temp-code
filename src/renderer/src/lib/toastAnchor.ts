/**
 * The element the toast stack sits above: the focused thread's strip and
 * composer (ChatFooter marks it). A registry instead of a DOM query, so
 * nothing watches the document while a transcript streams. The newest
 * registration wins: the pane that gained focus registers last.
 */
const anchors: HTMLElement[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** A ref callback: registers the element, and its cleanup unregisters it. */
export function registerToastAnchor(el: HTMLElement | null): (() => void) | undefined {
  if (!el) return undefined;
  anchors.push(el);
  emit();
  return () => {
    const at = anchors.lastIndexOf(el);
    if (at < 0) return;
    anchors.splice(at, 1);
    emit();
  };
}

export function subscribeToastAnchor(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function toastAnchor(): HTMLElement | null {
  return anchors[anchors.length - 1] ?? null;
}
