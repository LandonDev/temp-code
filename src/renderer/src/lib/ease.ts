/** Shared-layout glides: pills, washes and panels morphing between positions. */
export const SPRING_LAYOUT = {
  type: "spring",
  stiffness: 360,
  damping: 32,
  mass: 0.6,
} as const;

/** Overlay panel entrances and the row-to-detail morph. */
export const SPRING_PANEL = {
  type: "spring",
  stiffness: 420,
  damping: 40,
  mass: 0.5,
} as const;

/** Quick exits: a fast ease-out for panels folding away. */
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;

/** Icon swaps inside a button: the composer's Send → Queue → Pause morph. */
export const SPRING_SWAP = {
  type: "spring",
  stiffness: 460,
  damping: 32,
  mass: 0.55,
} as const;
