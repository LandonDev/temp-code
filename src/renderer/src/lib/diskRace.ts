// The disk race: what an editor does when the file changed on disk while
// the buffer held unsaved edits. Pure, shared by the Monaco models and the
// Markdown editor, so neither ever writes over a change it has not seen.
import { minimalEdit } from "./monaco/minimalEdit";

/** base: what the editor last read from or wrote to disk; mine: the
 *  buffer; theirs: the disk now. */
export type DiskRace =
  | { kind: "ours" } // disk unchanged since base: write mine
  | { kind: "theirs" } // buffer unchanged since base: take the disk
  | { kind: "same" } // buffer already equals the disk
  | { kind: "merged"; text: string } // both changed, different lines
  | { kind: "conflict" }; // both changed the same or neighbouring lines

type Span = { start: number; end: number; text: string; first: number; last: number };

function lineOf(text: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** The one changed span of base, with the base lines it touches. */
function spanOf(base: string, next: string): Span | null {
  const edit = minimalEdit(base, next);
  if (!edit) return null;
  const first = lineOf(base, edit.start);
  const last = edit.endCur > edit.start ? lineOf(base, edit.endCur - 1) : first;
  return { start: edit.start, end: edit.endCur, text: edit.text, first, last };
}

/** Both sides changed base: merge when their lines are apart by at least
 *  one untouched line (git's rule: neighbouring lines conflict). One span
 *  per side keeps it conservative: never a wrong merge, sometimes a bar. */
export function settleDiskRace(base: string, mine: string, theirs: string): DiskRace {
  if (mine === theirs) return { kind: "same" };
  if (theirs === base) return { kind: "ours" };
  if (mine === base) return { kind: "theirs" };
  const a = spanOf(base, mine);
  const b = spanOf(base, theirs);
  if (!a || !b) return { kind: "conflict" };
  const [early, late] = a.start <= b.start ? [a, b] : [b, a];
  if (early.last + 1 >= late.first) return { kind: "conflict" };
  const text =
    base.slice(0, early.start) + early.text + base.slice(early.end, late.start) + late.text + base.slice(late.end);
  return { kind: "merged", text };
}

export type RacedWrite =
  /** text is now on disk; merged: it holds the disk's lines too. */
  | { kind: "written"; text: string; merged: boolean }
  /** Nothing written: the disk already holds what the buffer should be. */
  | { kind: "current"; text: string }
  /** Nothing written: the disk changed the lines being edited. */
  | { kind: "conflict"; theirs: string };

/** The one write path both editors use. Reads the disk first; a read that
 *  fails writes mine (a deletion is the watcher's to report, and a write
 *  that fails stays the save error it is today). */
export async function writeUnlessRaced(
  io: { read(): Promise<string>; write(text: string): Promise<void> },
  base: string,
  mine: string,
): Promise<RacedWrite> {
  let theirs: string;
  try {
    theirs = await io.read();
  } catch {
    await io.write(mine);
    return { kind: "written", text: mine, merged: false };
  }
  const race = settleDiskRace(base, mine, theirs);
  switch (race.kind) {
    case "ours":
      await io.write(mine);
      return { kind: "written", text: mine, merged: false };
    case "merged":
      await io.write(race.text);
      return { kind: "written", text: race.text, merged: true };
    case "same":
    case "theirs":
      return { kind: "current", text: theirs };
    case "conflict":
      return { kind: "conflict", theirs };
  }
}
