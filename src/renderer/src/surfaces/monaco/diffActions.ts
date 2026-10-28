/**
 * Pure helpers for the review tab's Revert and Stage (DiffSurface): Monaco
 * speaks lines and columns, editorGit's chunk functions speak offsets into
 * LF text. Kept apart from Monaco so they test without an editor.
 */

/** The part of a Monaco line change the helpers read. */
export type LineChange = { modifiedStartLineNumber: number; modifiedEndLineNumber: number };

/** The offset (into LF text) where a change starts. A pure deletion sits
 *  after `modifiedStartLineNumber` (0 at the top), so it answers the start
 *  of the next line, clamped to the last, where findChunk finds the chunk. */
export function changeOffset(text: string, change: LineChange): number {
  const starts = lineStarts(text);
  const line = change.modifiedEndLineNumber === 0 ? change.modifiedStartLineNumber + 1 : change.modifiedStartLineNumber;
  return starts[Math.min(starts.length, Math.max(1, line)) - 1];
}

/** The start of every line a change covers: a change part of which is
 *  already staged still has its other lines to stage. */
export function changeLineOffsets(text: string, change: LineChange): number[] {
  if (change.modifiedEndLineNumber === 0) return [changeOffset(text, change)];
  const starts = lineStarts(text);
  const out: number[] = [];
  for (let line = Math.max(1, change.modifiedStartLineNumber); line <= Math.min(starts.length, change.modifiedEndLineNumber); line++) out.push(starts[line - 1]);
  return out;
}

/** The smallest replacement turning `prev` into `next`: offsets into `prev`. */
export function minimalEdit(prev: string, next: string): { start: number; end: number; insert: string } {
  let start = 0;
  const max = Math.min(prev.length, next.length);
  while (start < max && prev[start] === next[start]) start++;
  let tail = 0;
  while (tail < max - start && prev[prev.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
  return { start, end: prev.length - tail, insert: next.slice(start, next.length - tail) };
}

/** A 1-based line and column for an offset into LF text. */
export function positionAt(text: string, offset: number): { lineNumber: number; column: number } {
  const starts = lineStarts(text);
  let line = starts.length;
  while (line > 1 && starts[line - 1] > offset) line--;
  return { lineNumber: line, column: offset - starts[line - 1] + 1 };
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}
