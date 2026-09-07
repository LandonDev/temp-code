/**
 * Editor-first keys. The app's global shortcut listener sits on window
 * capture and claims chords like ⌘P before a focused Monaco editor sees
 * them. This module registers an earlier capture listener (main.tsx
 * imports it before App) that lets the editor chunk claim a chord for the
 * focused editor: the handler runs the editor action itself and the event
 * stops here. No monaco import — the chunk installs its handler on load.
 */

/** Returns true when it handled the chord for the focused editor. */
export type MonacoKeyHandler = (e: KeyboardEvent) => boolean;

let handler: MonacoKeyHandler | null = null;

export function setMonacoKeyHandler(next: MonacoKeyHandler | null): void {
  handler = next;
}

export function insideMonaco(target: EventTarget | null): boolean {
  const el = target as { closest?: (selector: string) => unknown } | null;
  return typeof el?.closest === "function" && !!el.closest(".monaco-editor");
}

/** The chords the editor keeps for itself while it has focus. */
export function isEditorChord(e: KeyboardEvent): boolean {
  if (e.isComposing) return false;
  if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "p") return true;
  return false;
}

export function onEditorKeydown(e: KeyboardEvent): void {
  if (!insideMonaco(e.target) || !isEditorChord(e)) return;
  if (!handler?.(e)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
}

export function installEditorKeys(target: Pick<Window, "addEventListener"> = window): void {
  target.addEventListener("keydown", onEditorKeydown as EventListener, true);
}
