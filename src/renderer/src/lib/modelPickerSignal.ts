/**
 * The failure card's "Pick another model" opens the composer's model picker
 * without reaching into it: the card dispatches this on `window`, and the
 * active composer's picker (the one with hotkeys) opens on it.
 */
export const OPEN_MODEL_PICKER = "tc:open-model-picker";

export function requestModelPicker(sessionId: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_MODEL_PICKER, { detail: { sessionId } }));
}
