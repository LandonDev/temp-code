import type { MidTurnDefault } from "./settings";

/** What the composer's one button (and Enter) does right now. */
export type ComposerIntent = "send" | "queue" | "steer" | "pause";

export type ComposerState = {
  /** A turn is running (or starting, or waiting on the user). */
  busy: boolean;
  /** The turn is paused: nothing drains until Continue. */
  paused: boolean;
  /** The box has text or attachments. */
  hasText: boolean;
  /** ⌘Enter / ⌘click: do the other mid-turn action. */
  invert: boolean;
  midTurnDefault: MidTurnDefault;
};

/**
 * Paused → queue (it goes on resume). Running with text → the settings
 * default, ⌘ inverts it. Running with an empty box → pause. Idle → send.
 */
export function decideComposerAction(state: ComposerState): ComposerIntent {
  if (state.paused) return "queue";
  if (!state.busy) return "send";
  if (!state.hasText) return "pause";
  const queue = (state.midTurnDefault === "queue") !== state.invert;
  return queue ? "queue" : "steer";
}

export function composerActionLabel(intent: ComposerIntent): string {
  switch (intent) {
    case "send":
      return "Send";
    case "queue":
      return "Queue";
    case "steer":
      return "Steer";
    case "pause":
      return "Pause";
  }
}

/** The second line of the button's tooltip while a turn runs: the other
 *  key and what it does ("⌘⏎ steers" while Enter queues, and back). */
export function composerActionHint(
  intent: ComposerIntent,
  mod: string,
): { keys: string; verb: string } | undefined {
  if (intent === "queue") return { keys: `${mod}⏎`, verb: "steers" };
  if (intent === "steer") return { keys: `${mod}⏎`, verb: "queues" };
  return undefined;
}
