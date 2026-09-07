/**
 * The app's motion vocabulary (ported from temp-code): every spring and
 * curve lives here so a button press, a panel slide, and a pill glide all
 * share one feel. Nothing in the UI hand-rolls a transition.
 */

/** Button presses: a quick spring with a small overshoot. */
export const SPRING_PRESS = {
  type: "spring",
  stiffness: 500,
  damping: 30,
  mass: 0.6,
} as const;

/** Icon swaps inside a button: the composer's Send → Queue → Pause morph. */
export const SPRING_SWAP = {
  type: "spring",
  stiffness: 460,
  damping: 30,
  mass: 0.55,
} as const;

/** Overlay panel entrances and the row-to-detail morph. */
export const SPRING_PANEL = {
  type: "spring",
  stiffness: 420,
  damping: 40,
  mass: 0.5,
} as const;

/** Shared-layout glides: pills, washes and panels morphing between positions. */
export const SPRING_LAYOUT = {
  type: "spring",
  stiffness: 360,
  damping: 32,
  mass: 0.6,
} as const;

/** Elements that trail the pointer (magnetic pulls). */
export const SPRING_MOUSE = {
  type: "spring",
  stiffness: 200,
  damping: 15,
  mass: 0.3,
} as const;

/** Long, settled travel: a sidebar reopening, a card gliding home. */
export const SPRING_GLIDE = {
  type: "spring",
  stiffness: 700,
  damping: 50,
  mass: 0.5,
} as const;

/** Quick exits: a fast ease-out for panels folding away. */
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;

/** Symmetric moves: a reveal that returns the way it came. */
export const EASE_IN_OUT = [0.77, 0, 0.175, 1] as const;

/** Drawers and sheets sliding from an edge. */
export const EASE_DRAWER = [0.32, 0.72, 0, 1] as const;

/** EASE_OUT as a CSS timing function, for keyframes and transitions. */
export const EASE_OUT_CSS = "cubic-bezier(0.16, 1, 0.3, 1)";
