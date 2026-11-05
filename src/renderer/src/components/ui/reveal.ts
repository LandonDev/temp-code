/**
 * The one hover reveal (docs/DESIGN.md "Hover reveal"): controls a row, a
 * message or a block shows only while the pointer is over it. The classes
 * go on a WRAPPER around the controls, never on a button, so each button
 * keeps its own hover fill on `--dur-hover`.
 *
 * - The pointer: the wrapper waits `--delay-hover`, then fades in over
 *   `--dur-fast`, so a pointer crossing a list flashes nothing; leaving
 *   fades out at once.
 * - The keyboard: a control inside the wrapper with focus-visible shows it at
 *   once (`has-focus-visible`). A mouse click never holds it: focus-within is
 *   never a reveal's trigger (lib/revealGuard.test.ts refuses it).
 * - An open menu or popover whose trigger sits inside holds it
 *   (`has-[[data-popup-open]]`).
 * - Reduced motion keeps the fade (`motion-reduce:transition-opacity`).
 *
 * `group` names the hover group the wrapper answers to: the element that
 * carries `group/<name>` (`""` for an unnamed `group`). The classes are
 * built from the name here, so Tailwind finds them in index.css's
 * `@source inline` lists, not in this file: a new group joins those lists
 * and the union below.
 *
 * `row`: the row takes keyboard focus itself (a `role="button"` row) or
 * holds other focusable parts, so focus-visible on the group or anywhere in
 * it shows the controls at once too.
 * `overlay`: the controls lie over something at rest (counts, the model
 * mark), so they take no pointer until the group is hovered.
 */

export type RevealGroup = "" | "body" | "code" | "details" | "dock-tab" | "html-render" | "hunk" | "item" | "message" | "model" | "notice" | "output" | "q" | "row" | "steps" | "turnend";
/** The groups whose rows take focus (index.css lists their `row` variants). */
export type RevealRowGroup = "" | "dock-tab" | "hunk" | "item" | "row" | "steps";
/** The groups whose controls lie over something (`overlay`) and what yields to them. */
export type YieldGroup = "" | "item" | "row";

const BASE =
  "opacity-0 duration-(--dur-fast) ease-(--ease-out) starting:opacity-0 has-focus-visible:opacity-100 has-focus-visible:delay-(--dur-instant) has-[[data-popup-open]]:opacity-100 has-[[data-popup-open]]:delay-(--dur-instant)";
/** What a reveal transitions: its opacity, and an overlay's pointer with it
 *  (discrete, so it turns on halfway through the fade, never before it). */
const MOVES = "transition-opacity motion-reduce:transition-opacity";
const OVERLAY_MOVES = "transition-[opacity,pointer-events] transition-discrete motion-reduce:transition-[opacity,pointer-events]";

const FADE = "transition-opacity duration-(--dur-fast) ease-(--ease-out) motion-reduce:transition-opacity";

/** `group-hover/<name>`, or `group-hover` for the unnamed group. */
const on = (variant: string, group: string) => (group ? `${variant}/${group}` : variant);

/** Shown `state` at once (`--dur-instant`) under each variant. */
const atOnce = (variants: string[], group: string, state: string) =>
  variants.map((variant) => `${on(variant, group)}:${state} ${on(variant, group)}:delay-(--dur-instant)`).join(" ");

/** The wrapper's classes for controls revealed by `group/<group>`'s hover. */
export function reveal(group: RevealGroup): string;
export function reveal(group: RevealRowGroup, options: { row?: boolean }): string;
export function reveal(group: YieldGroup, options: { row?: boolean; overlay: true }): string;
export function reveal(group: RevealGroup, options: { row?: boolean; overlay?: boolean } = {}): string {
  const hover = on("group-hover", group);
  let cls = `${BASE} ${options.overlay ? OVERLAY_MOVES : MOVES} ${hover}:opacity-100 ${hover}:delay-(--delay-hover)`;
  if (options.row) cls += ` ${atOnce(["group-focus-visible", "group-has-focus-visible"], group, "opacity-100")}`;
  if (options.overlay) cls += ` pointer-events-none ${hover}:pointer-events-auto has-[[data-popup-open]]:pointer-events-auto`;
  return cls;
}

/** What gives way to a reveal in the same place (a model mark, a row's
 *  counts): it fades out on the reveal's own timing, so the two cross over
 *  together, and comes back at once when the group is left. Pair it with a
 *  `row` reveal: keyboard focus on or in the group yields it. */
export function yields(group: YieldGroup): string {
  const hover = on("group-hover", group);
  return `${FADE} ${hover}:opacity-0 ${hover}:delay-(--delay-hover) ${atOnce(["group-focus-visible", "group-has-focus-visible", "group-has-[[data-popup-open]]"], group, "opacity-0")}`;
}

/** A control that appears with what it belongs to (the title bar's agents
 *  cue): it fades in over `--dur-fast` from `@starting-style` and leaves at
 *  once. On a wrapper, like a reveal, so the control keeps its hover fill. */
export const FADE_IN = `${FADE} starting:opacity-0`;
