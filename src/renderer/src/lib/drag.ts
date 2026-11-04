/** How far a press moves before it is a drag rather than a click. */
export const DRAG_THRESHOLD = 5;

export function setGrabbing(on: boolean) {
  document.body.style.cursor = on ? "grabbing" : "";
}

/** Block native text selection for the duration of a reorder gesture. */
export function suppressTextSelection() {
  const onSelectStart = (event: Event) => {
    event.preventDefault();
  };
  window.addEventListener("selectstart", onSelectStart);
  document.documentElement.classList.add("is-reordering");
  window.getSelection()?.removeAllRanges();
  return () => {
    window.removeEventListener("selectstart", onSelectStart);
    document.documentElement.classList.remove("is-reordering");
    window.getSelection()?.removeAllRanges();
  };
}

/** Diminishing overshoot past a bound: what is dragged stretches, but ever
 *  more reluctantly, as a real thing slows before it stops. */
export function rubberband(over: number, dimension = 300) {
  return (over * dimension * 0.55) / (dimension + 0.55 * over);
}

/** A dragged value past `[min, max]` follows the pointer on the rubber band. */
export function rubber(raw: number, min: number, max: number, dimension = 300) {
  if (raw > max) return max + rubberband(raw - max, dimension);
  if (raw < min) return min - rubberband(min - raw, dimension);
  return raw;
}

/** One pointer reading during a drag: where it was (on the drag's axis) and when. */
export type DragSample = { at: number; t: number };

/** How far back a drag's speed is read: older readings no longer say what the hand is doing. */
const VELOCITY_WINDOW_MS = 100;

/** Keep the last few readings of a drag, enough for `releaseVelocity`. */
export function pushSample(samples: DragSample[], at: number, t: number) {
  samples.push({ at, t });
  if (samples.length > 6) samples.shift();
}

/**
 * The pointer's speed at release in px/s, from the readings of the last 100ms:
 * the earliest of them to the newest. A pointer that rested before it let go
 * (its newest reading older than the window at `now`) has no speed.
 */
export function releaseVelocity(samples: readonly DragSample[], now?: number): number {
  const last = samples[samples.length - 1];
  if (!last || (now !== undefined && now - last.t > VELOCITY_WINDOW_MS)) return 0;
  let first = last;
  for (let i = samples.length - 2; i >= 0; i--) {
    if (last.t - samples[i]!.t > VELOCITY_WINDOW_MS) break;
    first = samples[i]!;
  }
  const dt = last.t - first.t;
  return dt > 0 ? ((last.at - first.at) / dt) * 1000 : 0;
}
