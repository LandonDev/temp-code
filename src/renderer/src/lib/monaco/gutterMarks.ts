import type { Text } from "@codemirror/state";

export type GutterMark = { line: number; kind: "add" | "change" | "delete" };

/** Map merge chunks (offsets into A = HEAD, B = buffer) to per-line marks in B. */
export function gutterMarks(
  chunks: readonly {
    fromA: number;
    toA: number;
    fromB: number;
    toB: number;
    changes?: readonly { fromA: number; toA: number; fromB: number; toB: number }[];
  }[],
  current: Text,
): GutterMark[] {
  const marks: GutterMark[] = [];
  for (const chunk of chunks) {
    const added = chunk.toA === chunk.fromA;
    // A chunk whose every change inserts nothing into B is a deletion, even
    // when the line-based chunk drags the neighbouring kept line along.
    const removed =
      chunk.toB === chunk.fromB ||
      (!!chunk.changes?.length && chunk.changes.every((c) => c.fromB === c.toB));
    if (removed) {
      // Deleted lines sit between two kept lines; mark the one after them
      // (or the last line when the deletion trails the file).
      const at = Math.min(chunk.fromB, current.length);
      marks.push({ line: current.lineAt(at).number, kind: "delete" });
      continue;
    }
    const first = current.lineAt(chunk.fromB).number;
    // toB points at the start of the line after the chunk.
    const last = current.lineAt(Math.max(chunk.fromB, chunk.toB - 1)).number;
    for (let line = first; line <= last; line++) {
      marks.push({ line, kind: added ? "add" : "change" });
    }
  }
  return marks;
}
