import { TASK_BORDER_PX, TASK_CHEVRON_PX, TASK_GAP_PX, TASK_INSET_PX, TASK_MARK_PX, TASK_TALLY_GAP_PX } from "../components/ui/task-list";

/**
 * How wide a task list wants to be: the widest task on one line (mark,
 * label, time) inside the card, never less than its header. The board
 * column takes it, never under `FIT_MIN_PX` and never over half the pane
 * (the 50% is SplitShell's CSS `min()`, so no pane width is read here).
 */

/** A text's width in px in one of the list's two faces. */
export type Measure = (text: string, font: "label" | "time") => number;

/** The column never goes narrower than this. */
export const FIT_MIN_PX = 320;

/** The widest time a row shows under an hour, so a ticking time never widens the list. */
const WIDEST_TIME = "59m 59s";

export type FitInput = {
  labels: readonly string[];
  /** Some task carries a time, so each row keeps a slot for one. */
  hasTimes: boolean;
  /** The header's words: the title and the tally ("Tasks", "3/7"). */
  header?: { title: string; tally: string };
};

/** The card's width in px: its border, inset and widest row, or its header if wider. */
export function fitCard({ labels, hasTimes, header }: FitInput, measure: Measure): number {
  const lead = TASK_MARK_PX + TASK_GAP_PX;
  let widest = 0;
  for (const label of labels) widest = Math.max(widest, measure(label, "label"));
  const time = hasTimes ? TASK_GAP_PX + measure(WIDEST_TIME, "time") : 0;
  const row = lead + widest + time;
  const head = header
    ? lead + measure(header.title, "label") + TASK_GAP_PX + measure(header.tally, "label") + TASK_TALLY_GAP_PX + TASK_CHEVRON_PX
    : 0;
  return Math.ceil(2 * (TASK_BORDER_PX + TASK_INSET_PX) + Math.max(row, head));
}

/** The board column for a card of `card` px inside `inset` px a side, no
 *  wider than the board's content can be (`max`): past it the width would
 *  be empty margin, and a longer label cuts as it always has. */
export function fitColumn(card: number, inset: number, max = Infinity): number {
  return Math.min(max, Math.max(FIT_MIN_PX, card + 2 * inset));
}

let context: OffscreenCanvasRenderingContext2D | null | undefined;
const widths = new Map<string, number>();

/** Measures with one shared offscreen canvas in the given CSS fonts,
 *  cached per font and text; null where there is no canvas (jsdom). */
export function canvasMeasure(fonts: Record<"label" | "time", string>): Measure | null {
  if (context === undefined) context = typeof OffscreenCanvas === "undefined" ? null : new OffscreenCanvas(1, 1).getContext("2d");
  const ctx = context;
  if (!ctx) return null;
  return (text, font) => {
    const key = `${fonts[font]}\n${text}`;
    let width = widths.get(key);
    if (width === undefined) {
      ctx.font = fonts[font];
      width = ctx.measureText(text).width;
      if (widths.size > 2000) widths.clear();
      widths.set(key, width);
    }
    return width;
  };
}

/** An element's computed font as a canvas `font` string. */
export function cssFont(el: Element): string {
  const style = getComputedStyle(el);
  return style.font || `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
}
