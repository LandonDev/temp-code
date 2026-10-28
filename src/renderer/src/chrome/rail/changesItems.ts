import type { CompareResult, FileChange } from "@server/shared/domain";
import type { GitChangedFile, GitDiffIndex } from "../../lib/fs";

/**
 * The Changes section's scroll body as one flat list (ChangesPanel renders it
 * through the rail's virtualizer, so its cost follows the viewport whatever
 * the count): the index's groups, then the Against group's head, its files
 * and its commits fold. A checkout once listed 8,985 files here, and every
 * warm tab kept its own copy mounted.
 */

export type ChangeSide = "staged" | "unstaged";

/** A fold's key, and its row's: a file in both groups folds each group on its own. */
export function foldKey(side: ChangeSide, relative: string): string {
  return `${side === "staged" ? "s" : "u"}:${relative}`;
}

export type ChangesItem = (
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "heading"; side: ChangeSide; label: "Staged" | "Changes"; count: number }
  | { kind: "file"; side: ChangeSide; file: GitChangedFile }
  | { kind: "against" }
  | { kind: "against-file"; file: FileChange }
  | { kind: "commits" }
) & {
  key: string;
  /** Opens a group after another: 16px above it (docs/DESIGN.md "Spacing"). */
  gap: boolean;
};

/** Distributes Omit over the union, so each kind keeps its own fields. */
type Bare<T> = T extends unknown ? Omit<T, "gap"> : never;

/** `against` is the Against group's comparison when the checkout is a
 *  project's (undefined while it loads), absent outside one. */
export function changesItems(index: GitDiffIndex | null, against?: { compare: CompareResult | null | undefined }): ChangesItem[] {
  const out: ChangesItem[] = [];
  const group = (items: Bare<ChangesItem>[]) => {
    items.forEach((item, i) => out.push({ ...item, gap: i === 0 && out.length > 0 } as ChangesItem));
  };
  const files = index?.files ?? [];
  if (!index) group([{ kind: "loading", key: "loading" }]);
  else if (files.length === 0) group([{ kind: "empty", key: "empty" }]);
  else {
    const staged = files.filter((f) => f.staged);
    const unstaged = files.filter((f) => f.unstaged);
    // A group's heading shows only where two groups meet.
    const both = staged.length > 0 && unstaged.length > 0;
    for (const [side, label, rows] of [
      ["staged", "Staged", staged],
      ["unstaged", "Changes", unstaged],
    ] as const) {
      if (rows.length === 0) continue;
      group([
        ...(both ? [{ kind: "heading", side, label, count: rows.length, key: `h:${side}` } as const] : []),
        ...rows.map((file) => ({ kind: "file", side, file, key: foldKey(side, file.relative) }) as const),
      ]);
    }
  }
  if (against) {
    const compare = against.compare;
    group([
      { kind: "against", key: "against" },
      ...(compare?.files ?? []).map((file) => ({ kind: "against-file", file, key: `a:${file.path}` }) as const),
      ...(compare && (compare.ours.length > 0 || compare.theirs.length > 0) ? [{ kind: "commits", key: "commits" } as const] : []),
    ]);
  }
  return out;
}

/** A row's height before the ResizeObserver reports it: the rows are 28px,
 *  a heading 24px, the Against head 32px; a gap adds its 16px. */
export function estimateItem(item: ChangesItem): number {
  const own =
    item.kind === "heading" ? 24 : item.kind === "against" ? 32 : item.kind === "loading" ? 92 : item.kind === "empty" ? 76 : 28;
  return own + (item.gap ? 16 : 0);
}
