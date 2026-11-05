import { useLayoutEffect, useState } from "react";
import type { BoardDigest } from "@server/shared/contract-batch";
import { canvasMeasure, type Measure } from "../../../lib/taskListWidth";
import { BAR_TYPES } from "./rowBody";

/**
 * How wide the master board's task bars are (docs/LAYOUT.md "Master"): as
 * wide as the folded task list's widest row, over the tasks of every
 * implementation and orchestration row on the board, so every bar is one
 * width and an open list ends where its bar ends. One width per board,
 * handed to the rows as the `--task-bar` CSS variable on the list, so a
 * re-measure re-renders no row.
 */

/** A compact task row's mark and the gap after it (CompactTaskRow in components/ui/task-list.tsx: size-3, gap-1.5). */
export const COMPACT_MARK_PX = 12;
export const COMPACT_GAP_PX = 6;
/** A bar never goes narrower than this, so a short list still reads as a bar. Its cap is the title
 *  column less the tally and chevron, which the line's flex keeps (the bar shrinks, they never do). */
export const TASK_BAR_MIN_PX = 160;

/** The bar's width in px for these task labels: the compact row's mark, its gap and the widest label. */
export function fitTaskBar(labels: readonly string[], measure: Measure): number {
  let widest = 0;
  for (const label of labels) widest = Math.max(widest, measure(label, "label"));
  return Math.max(TASK_BAR_MIN_PX, Math.ceil(COMPACT_MARK_PX + COMPACT_GAP_PX + widest));
}

/** Every task label of the board's implementation and orchestration rows,
 *  whatever their section, sorted and one a line: a key that changes only
 *  when the set of labels does, so a tick or a reorder measures nothing. */
export function boardTaskLabels(rows: readonly { id: string; threadType: string | null | undefined }[], digestOf: (id: string) => Pick<BoardDigest, "todos">): string {
  const labels = new Set<string>();
  for (const row of rows) {
    if (!BAR_TYPES.has(row.threadType ?? "")) continue;
    for (const todo of digestOf(row.id).todos ?? []) labels.add(todo.content);
  }
  return [...labels].sort().join("\n");
}

/** The compact row's label face: text-xs (0.75rem), regular, in the app's family. */
function compactMeasure(): Measure | null {
  const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const font = `400 ${String(0.75 * rem)}px ${getComputedStyle(document.body).fontFamily}`;
  return canvasMeasure({ label: font, time: font });
}

/**
 * The board's bar width for `labels` (one label a line, the set the board's
 * rows carry), measured before paint and again once the fonts load, the way
 * TaskList measures its card; null until something could measure (jsdom
 * with no `measureText`), where the bar keeps its CSS floor.
 */
export function useTaskBarWidth(labels: string, measureText?: Measure): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const list = labels ? labels.split("\n") : [];
    const report = (): void => {
      const measure = measureText ?? compactMeasure();
      if (measure) setWidth(fitTaskBar(list, measure));
    };
    report();
    let live = true;
    if (!measureText) {
      void document.fonts?.ready.then(() => {
        if (live) report();
      });
    }
    return () => {
      live = false;
    };
  }, [labels, measureText]);
  return width;
}

/** The style that hands the width to every bar under it. */
export function taskBarStyle(width: number | null): Record<string, string> | undefined {
  return width === null ? undefined : { "--task-bar": `${String(width)}px` };
}
