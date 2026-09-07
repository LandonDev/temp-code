import type { Block, ToolPreviewLine } from "../lib/session";

/**
 * The rows behind an edit row's diff. Two sources feed it: the tool input
 * (Edit/MultiEdit/Write/apply_patch carry the change itself) becomes hunks
 * that are located in the landed file, and the server's short preview is
 * the fallback when the input carries no text.
 */

export type DiffRowType = "add" | "del" | "ctx" | "gap";

/** One line of a unified diff view. `gap` separates hunks. */
export interface DiffRow {
  type: DiffRowType;
  oldNo?: number;
  newNo?: number;
  text: string;
}

export interface Hunk {
  old: string[];
  new: string[];
}

export interface EditDiff {
  hunks: Hunk[];
  /** Rows numbered by the source itself (a patch, a whole-file write). */
  rows?: DiffRow[];
}

/** Past this many rows a diff is cut off. */
export const DIFF_LINE_CAP = 600;

/** How long a settled edit's rows take to pour in. */
export function revealDuration(rows: number): number {
  return Math.min(900, 150 + rows * 6);
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const lines = (s: string): string[] => (s === "" ? [] : s.split("\n"));
const nonEmpty = (h: Hunk): boolean => h.old.length > 0 || h.new.length > 0;

/** Server preview lines → rows. `number` is the new-side line for adds and
 *  context and the old-side line for deletes; a jump on the new side
 *  becomes a gap. */
export function previewToRows(preview: ToolPreviewLine[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let lastNew: number | undefined;
  for (const l of preview) {
    if (l.kind === "del") {
      rows.push({ type: "del", oldNo: l.number, text: l.text });
      continue;
    }
    const newNo = l.number;
    if (newNo !== undefined && lastNew !== undefined && newNo > lastNew + 1) {
      rows.push({ type: "gap", text: "" });
    }
    rows.push({ type: l.kind === "add" ? "add" : "ctx", newNo, text: l.text });
    if (newNo !== undefined) lastNew = newNo;
  }
  return rows;
}

/** A unified diff → numbered rows plus the change runs as hunks. A file
 *  add with no markers is every line added. Context between two change
 *  runs splits them into separate hunks so each locates on its own. */
export function parseUnifiedDiff(diff: string, create = false): EditDiff {
  const all = lines(diff);
  if (create || !all.some((l) => /^[@+-]/.test(l))) {
    return {
      hunks: all.length ? [{ old: [], new: all }] : [],
      rows: all.map((text, n) => ({ type: "add", newNo: n + 1, text })),
    };
  }
  const hunks: Hunk[] = [];
  const rows: DiffRow[] = [];
  let cur: Hunk | null = null;
  let oldNo = 1;
  let newNo = 1;
  let started = false;
  for (const l of all) {
    if (l.startsWith("@@")) {
      const m = /-(\d+)[^+]*\+(\d+)/.exec(l);
      if (m) {
        oldNo = Number(m[1]);
        newNo = Number(m[2]);
      }
      if (started) rows.push({ type: "gap", text: "" });
      started = true;
      cur = null;
      continue;
    }
    if (l.startsWith("+++") || l.startsWith("---")) continue;
    if (l.startsWith("+") || l.startsWith("-")) {
      if (!cur) {
        cur = { old: [], new: [] };
        hunks.push(cur);
      }
      if (l.startsWith("+")) {
        cur.new.push(l.slice(1));
        rows.push({ type: "add", newNo: newNo++, text: l.slice(1) });
      } else {
        cur.old.push(l.slice(1));
        rows.push({ type: "del", oldNo: oldNo++, text: l.slice(1) });
      }
      continue;
    }
    if (l.startsWith("\\")) continue;
    cur = null;
    rows.push({
      type: "ctx",
      oldNo: oldNo++,
      newNo: newNo++,
      text: l.replace(/^ /, ""),
    });
  }
  return { hunks: hunks.filter(nonEmpty), rows };
}

/** Raw `*** Begin Patch` text: the first file's hunks (no numbers). */
export function parseApplyPatchFile(text: string): EditDiff {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  let inFile = false;
  for (const l of lines(text)) {
    if (/^\*\*\* (Add|Delete|Update) File: /.test(l)) {
      if (inFile) break;
      inFile = true;
      continue;
    }
    if (!inFile || l.startsWith("***")) continue;
    if (l.startsWith("@@")) {
      cur = null;
      continue;
    }
    if (l.startsWith("+") || l.startsWith("-")) {
      if (!cur) {
        cur = { old: [], new: [] };
        hunks.push(cur);
      }
      (l.startsWith("+") ? cur.new : cur.old).push(l.slice(1));
    } else {
      cur = null;
    }
  }
  return { hunks: hunks.filter(nonEmpty) };
}

/** The change an edit block carries in its input, as hunks. Empty when the
 *  input has no text yet (still streaming) or the tool is not one we read. */
export function editDiff(block: Block): EditDiff {
  const tool = block.tool ?? {};
  const i = rec(tool.input);
  switch (tool.name ?? "") {
    case "Edit":
      return {
        hunks: [{ old: lines(str(i.old_string)), new: lines(str(i.new_string)) }].filter(nonEmpty),
      };
    case "MultiEdit": {
      const edits = Array.isArray(i.edits) ? (i.edits as unknown[]).map(rec) : [];
      return {
        hunks: edits
          .map((e) => ({ old: lines(str(e.old_string)), new: lines(str(e.new_string)) }))
          .filter(nonEmpty),
      };
    }
    case "Write": {
      if (typeof i.content !== "string") return { hunks: [] };
      const content = lines(i.content);
      return {
        hunks: content.length ? [{ old: [], new: content }] : [],
        rows: content.map((text, n) => ({ type: "add", newNo: n + 1, text })),
      };
    }
    case "NotebookEdit": {
      const src = lines(str(i.new_source));
      return { hunks: src.length ? [{ old: [], new: src }] : [] };
    }
    case "apply_patch": {
      const changes = Array.isArray(tool.input) ? (tool.input as unknown[]).map(rec) : [];
      if (changes.length === 1) {
        const c = changes[0];
        return parseUnifiedDiff(str(c.diff), str(rec(c.kind).type) === "add");
      }
      if (changes.length > 1) return { hunks: [] };
      return parseApplyPatchFile(str(i.input) || str(i.patch));
    }
    default:
      return { hunks: [] };
  }
}

/** Hunks → unnumbered rows — the fallback while line numbers resolve. */
export function rowsFromHunks(hunks: Hunk[]): DiffRow[] {
  const rows: DiffRow[] = [];
  hunks.forEach((h, n) => {
    if (n > 0) rows.push({ type: "gap", text: "" });
    for (const t of h.old) rows.push({ type: "del", text: t });
    for (const t of h.new) rows.push({ type: "add", text: t });
  });
  return rows;
}

/** First index where `seq` appears contiguously in `lines`, else -1. */
export function findSeq(lines: string[], seq: string[]): number {
  if (!seq.length) return -1;
  outer: for (let i = 0; i <= lines.length - seq.length; i++) {
    for (let j = 0; j < seq.length; j++) {
      if (lines[i + j] !== seq[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** Where a hunk's landed text starts in the file. Exact match first; if
 *  the user has since tweaked the middle, anchor on an edge line. */
export function locateStart(lines: string[], h: Hunk): number {
  const exact = findSeq(lines, h.new);
  if (exact !== -1 || h.new.length === 0) return exact;
  const first = lines.indexOf(h.new[0]);
  if (first !== -1) return first;
  const last = lines.lastIndexOf(h.new[h.new.length - 1]);
  return last === -1 ? -1 : Math.max(0, last - (h.new.length - 1));
}

/** Number hunks by finding the landed text in the file, wrapped in two
 *  lines of context. Added rows render the file's CURRENT lines, so an
 *  in-place tweak shows up when the diff re-locates after a save. */
export function locateHunks(hunks: Hunk[], content: string): DiffRow[] {
  const lines = content.split("\n");
  const rows: DiffRow[] = [];
  hunks.forEach((h, n) => {
    if (n > 0) rows.push({ type: "gap", text: "" });
    const start = locateStart(lines, h);
    if (start === -1) {
      for (const t of h.old) rows.push({ type: "del", text: t });
      for (const t of h.new) rows.push({ type: "add", text: t });
      return;
    }
    for (let i = Math.max(0, start - 2); i < start; i++) {
      rows.push({ type: "ctx", newNo: i + 1, text: lines[i] });
    }
    for (const t of h.old) rows.push({ type: "del", text: t });
    h.new.forEach((_, j) => {
      rows.push({ type: "add", newNo: start + j + 1, text: lines[start + j] ?? "" });
    });
    const end = start + h.new.length;
    for (let i = end; i < Math.min(lines.length, end + 2); i++) {
      rows.push({ type: "ctx", newNo: i + 1, text: lines[i] });
    }
  });
  return rows;
}

/** Contiguous numbered add-runs — what the model changed, for the inline
 *  editor's line wash. */
export function addRanges(rows: DiffRow[]): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const r of rows) {
    if (r.type !== "add" || r.newNo === undefined) continue;
    const last = out[out.length - 1];
    if (last && r.newNo === last.end + 1) last.end = r.newNo;
    else out.push({ start: r.newNo, end: r.newNo });
  }
  return out;
}
