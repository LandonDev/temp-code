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

/** Overlay panel entrances and the row-to-detail morph. */
export const SPRING_PANEL = {
  type: "spring",
  stiffness: 420,
  damping: 40,
  mass: 0.5,
} as const;

/** Shared-layout glides: pills, washes and panels morphing between positions,
 *  and icon swaps inside a button (the composer's Send → Queue → Pause). */
export const SPRING_LAYOUT = {
  type: "spring",
  stiffness: 360,
  damping: 32,
  mass: 0.6,
} as const;

/**
 * The durations, in seconds for Motion, mirroring the CSS tokens in
 * index.css (`--dur-fast`, `--dur-base`, `--dur-slow`, `--dur-drawer`);
 * ease.test.ts keeps the two in step.
 */
export const DUR = { fast: 0.12, base: 0.18, slow: 0.24, drawer: 0.3 } as const;

/** A released drag settling: a sash let go, a reordered row dropping home. */
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

/** A closing overlay's curve, as CSS `--ease-exit`. */
export const EASE_EXIT = [0.4, 0, 0.6, 1] as const;

/** The one entrance: fade up 4px over DUR.base. Spread onto a motion element. */
export const ENTER = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: DUR.base, ease: EASE_OUT },
} as const;

/** The one exit: a fade over DUR.fast. */
export const FADE_OUT = { opacity: 0, transition: { duration: DUR.fast, ease: EASE_OUT } } as const;

type Spring = { readonly stiffness: number; readonly damping: number; readonly mass: number };

/**
 * A spring as a CSS curve: its step response from 0 to 1 at rest, integrated
 * in 1 ms steps, sampled into `linear(0, …, 1)`. `ms` is the first instant
 * after which the spring stays within `rest` of 1 (0.005: half a pixel per
 * 100px of travel), rounded up to 10 ms. CSS transitions on this curve glide
 * like the Motion spring and need no JavaScript.
 */
export function springEasing(spring: Spring, points = 32, rest = 0.005): { ms: number; easing: string } {
  const { stiffness: k, damping: c, mass: m } = spring;
  const xs = [0];
  let x = 0;
  let v = 0;
  let settled = 0;
  for (let t = 1; t <= 5000; t++) {
    v += ((-k * (x - 1) - c * v) / m) * 0.001;
    x += v * 0.001;
    xs.push(x);
    if (Math.abs(1 - x) >= rest) settled = t;
  }
  const ms = Math.ceil((settled + 1) / 10) * 10;
  const samples = Array.from({ length: points }, (_, i) => {
    if (i === 0) return 0;
    if (i === points - 1) return 1;
    return Number(xs[Math.round((i / (points - 1)) * ms)].toFixed(4));
  });
  return { ms, easing: `linear(${samples.join(", ")})` };
}

/** SPRING_LAYOUT as a CSS curve and its duration. */
export const SPRING_LAYOUT_CSS = springEasing(SPRING_LAYOUT);
