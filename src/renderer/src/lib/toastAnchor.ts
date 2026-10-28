/**
 * The element the toast stack sits above: the focused thread's strip and
 * composer (ChatFooter marks it), or a master board's foot while its chat is
 * folded (BatchFoot). A registry instead of a DOM query, so nothing watches
 * the document while a transcript streams. The newest registration wins: the
 * pane that gained focus registers last. An anchor inside a folded column
 * (`inert`) seats nothing, and the next one down takes the stack; whoever
 * folds a column says so with `refreshToastAnchor`.
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
  for (let i = anchors.length - 1; i >= 0; i--) {
    if (!anchors[i].closest("[inert]")) return anchors[i];
  }
  return null;
}

/** A column folded or unfolded: the stack asks again which anchor it sits above. */
export function refreshToastAnchor(): void {
  emit();
}
