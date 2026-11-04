/**
 * Whether the last navigation came from the keyboard. App's key dispatch
 * marks it for every command a key ran; the next pointer press clears it.
 * What a keystroke shows appears at once (docs/DESIGN.md: nothing animates
 * on a keystroke), so a pane switched by ⌃Tab or ⌘1–9 mounts without its
 * fade while a click keeps it.
 */
let byKey = false;
let listening = false;

const clear = (): void => {
  byKey = false;
};

export function markKeyNav(): void {
  byKey = true;
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("pointerdown", clear, true);
}

export function navByKey(): boolean {
  return byKey;
}

/** Tests only: forget the last navigation. */
export function resetKeyNav(): void {
  byKey = false;
}
