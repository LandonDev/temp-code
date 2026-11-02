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

/** How long a scroller's bar stays shown after its last scroll, in ms
 *  (lib/scrollActivity.ts; docs/DESIGN.md "Scrolling"). */
export const SCROLL_IDLE_MS = 900;

/** The beat a working group holds open after its work moved on, in ms, so
 *  its last step's settle shows before it folds (transcript/ActionGroup.tsx). */
export const FOLD_HOLD_MS = 600;

/**
 * The spinner's 900ms turn (components/ui/spinner.tsx), run as a Web
 * Animation: the same turn as a CSS animation made Blink run a main-thread
 * frame at every display frame while any spinner showed.
 */
export const SPINNER_TURN: { keyframes: Keyframe[]; timing: KeyframeAnimationOptions } = {
  keyframes: [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }],
  timing: { duration: 900, iterations: Infinity, easing: "linear" },
};

/**
 * The streaming veil's clock (surfaces/streamVeil.ts): the cadence's seed,
 * the longest gap it counts, each chunk's fade bounds, and the text's alpha
 * at progress p, 1 − (1−p)^1.6, sampled for `linear()`.
 */
export const VEIL = {
  seedMs: 160,
  maxGapMs: 1000,
  minFadeMs: 120,
  maxFadeMs: 400,
  alpha: "linear(0, 0.155, 0.3, 0.435, 0.558, 0.67, 0.769, 0.854, 0.924, 0.975, 1)",
} as const;

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

/**
 * A CSS cubic-bezier curve as a function of progress, for code that drives
 * motion itself (the transcript's scroll glides): `cubicBezier(EASE_OUT)(t)`
 * is the eased progress at `t` in [0, 1]. Newton's method on x, then
 * bisection where the slope is too flat to trust.
 */
export function cubicBezier([x1, y1, x2, y2]: readonly [number, number, number, number]): (t: number) => number {
  const at = (a: number, b: number, s: number) => ((1 - 3 * b + 3 * a) * s + (3 * b - 6 * a)) * s * s + 3 * a * s;
  const slope = (a: number, b: number, s: number) => 3 * (1 - 3 * b + 3 * a) * s * s + 2 * (3 * b - 6 * a) * s + 3 * a;
  const solve = (x: number) => {
    let s = x;
    for (let i = 0; i < 8; i++) {
      const dx = at(x1, x2, s) - x;
      if (Math.abs(dx) < 1e-6) return s;
      const d = slope(x1, x2, s);
      if (Math.abs(d) < 1e-6) break;
      s -= dx / d;
    }
    let lo = 0;
    let hi = 1;
    s = x;
    while (hi - lo > 1e-6) {
      if (at(x1, x2, s) < x) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
    return s;
  };
  return (t) => (t <= 0 ? 0 : t >= 1 ? 1 : at(y1, y2, solve(t)));
}

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
