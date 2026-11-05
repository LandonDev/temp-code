import type { HarnessId } from "./session";

/**
 * The failure card's "Continue on another model" opens the composer's model
 * picker without reaching into it: the card dispatches this on `window`, and
 * the active composer's picker (the one with hotkeys) opens on it.
 */
export const OPEN_MODEL_PICKER = "tc:open-model-picker";

/** What the person picked: the model and its settings merged for it, as the composer keeps them. */
export interface ModelPick {
  harness: HarnessId;
  model: string;
  settings: Record<string, string>;
}

export interface ModelPickerRequest {
  sessionId: string;
  /** Called once, after the picker's own change, when this request ends in a pick; a close without one calls nothing. */
  onPick?: (pick: ModelPick) => void;
}

export function requestModelPicker(sessionId: string, opts: Omit<ModelPickerRequest, "sessionId"> = {}): void {
  const detail: ModelPickerRequest = { sessionId, ...opts };
  window.dispatchEvent(new CustomEvent(OPEN_MODEL_PICKER, { detail }));
}
