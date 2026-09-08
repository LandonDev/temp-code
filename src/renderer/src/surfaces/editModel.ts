import type { Block, ToolPreview } from "../lib/session";
import { displayPath } from "../lib/paths";

/**
 * A file change stands alone in the transcript — never folded into the
 * quiet run of tool calls. This is the model behind that row: which blocks
 * count as edits, and the file, verb, and +N / −N diffstat for one.
 */

export const EDIT_TOOLS = new Set([
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "apply_patch",
]);

export interface EditModel {
  path: string;
  adds: number;
  dels: number;
  /** The call creates the file. */
  create: boolean;
  /** The call removes the file. */
  remove: boolean;
  /** Further files the same call touches (multi-file patches). */
  extraPaths: string[];
  /** Live label while the call runs. */
  verb: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const lines = (s: string): string[] => (s === "" ? [] : s.split("\n"));

/** Edits, writes, patches, and deletes — by provider tool name, then by kind. */
export function isEditBlock(block: Block): boolean {
  const tool = block.tool;
  if (!tool) return false;
  if (tool.name && EDIT_TOOLS.has(tool.name)) return true;
  const kind = tool.kind?.trim().toLowerCase() ?? "";
  if (kind === "edit" || kind === "write" || kind === "delete") return true;
  return tool.preview?.kind === "write";
}

/** Unified diff (codex fileChange, git patch) → line counts. A whole-file
 *  add with no markers counts every line. */
export function parsePatchDiff(
  diff: string,
  isAdd: boolean,
): { adds: number; dels: number } {
  const all = lines(diff);
  if (isAdd || !all.some((l) => /^[@+-]/.test(l))) {
    return { adds: all.length, dels: 0 };
  }
  let adds = 0;
  let dels = 0;
  for (const l of all) {
    if (l.startsWith("+++") || l.startsWith("---") || l.startsWith("@@")) continue;
    if (l.startsWith("+")) adds++;
    else if (l.startsWith("-")) dels++;
  }
  return { adds, dels };
}

/** Raw `*** Begin Patch` text (codex apply_patch input): per-file headers
 *  with +/− bodies. */
export function parseApplyPatchText(text: string): {
  files: { path: string; create: boolean; remove: boolean; adds: number; dels: number }[];
} {
  const files: {
    path: string;
    create: boolean;
    remove: boolean;
    adds: number;
    dels: number;
  }[] = [];
  let cur: (typeof files)[number] | null = null;
  for (const l of lines(text)) {
    const head = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(l);
    if (head) {
      cur = {
        path: head[2].trim(),
        create: head[1] === "Add",
        remove: head[1] === "Delete",
        adds: 0,
        dels: 0,
      };
      files.push(cur);
      continue;
    }
    if (!cur || l.startsWith("***") || l.startsWith("@@")) continue;
    if (l.startsWith("+")) cur.adds++;
    else if (l.startsWith("-")) cur.dels++;
  }
  return { files };
}

function countPreviewLines(preview?: ToolPreview): { adds: number; dels: number } | null {
  if (preview?.additions !== undefined || preview?.deletions !== undefined) {
    return { adds: preview.additions ?? 0, dels: preview.deletions ?? 0 };
  }
  if (!preview?.lines?.length) return null;
  let adds = 0;
  let dels = 0;
  for (const l of preview.lines) {
    if (l.kind === "add") adds++;
    else if (l.kind === "del") dels++;
  }
  return adds || dels ? { adds, dels } : null;
}

export function editVerb(model: Pick<EditModel, "create" | "remove">, name?: string): string {
  if (model.remove) return "Deleting…";
  if (name === "apply_patch") return "Patching…";
  if (name === "Write" || model.create) return "Writing…";
  return "Editing…";
}

/** File, counts, and states for an edit block. Counts come from the tool
 *  input when it carries the change, else from the server's preview. */
export function editModel(block: Block): EditModel {
  const tool = block.tool ?? {};
  const name = tool.name ?? "";
  const i = rec(tool.input);
  const preview = tool.preview;
  const kind = tool.kind?.trim().toLowerCase() ?? "";
  const base: EditModel = {
    path: preview?.path ?? "",
    adds: 0,
    dels: 0,
    create: false,
    remove: kind === "delete",
    extraPaths: [],
    verb: "",
  };
  const finish = (m: EditModel): EditModel => ({ ...m, verb: editVerb(m, name) });
  const withPreview = (m: EditModel): EditModel => {
    const c = countPreviewLines(preview);
    return finish(c ? { ...m, adds: c.adds, dels: c.dels } : m);
  };
  switch (name) {
    case "Edit": {
      const o = lines(str(i.old_string));
      const nw = lines(str(i.new_string));
      if (!i.old_string && !i.new_string) return withPreview({ ...base, path: str(i.file_path) || base.path });
      return finish({ ...base, path: str(i.file_path) || base.path, adds: nw.length, dels: o.length });
    }
    case "MultiEdit": {
      const edits = Array.isArray(i.edits) ? (i.edits as unknown[]).map(rec) : [];
      if (edits.length === 0) return withPreview({ ...base, path: str(i.file_path) || base.path });
      return finish({
        ...base,
        path: str(i.file_path) || base.path,
        adds: edits.reduce((n, e) => n + lines(str(e.new_string)).length, 0),
        dels: edits.reduce((n, e) => n + lines(str(e.old_string)).length, 0),
      });
    }
    case "Write": {
      const path = str(i.file_path) || base.path;
      if (typeof i.content !== "string") return withPreview({ ...base, path, create: true });
      return finish({ ...base, path, create: true, adds: lines(i.content).length });
    }
    case "NotebookEdit": {
      const path = str(i.notebook_path) || base.path;
      if (typeof i.new_source !== "string") return withPreview({ ...base, path });
      return finish({ ...base, path, adds: lines(i.new_source).length });
    }
    case "apply_patch": {
      // Server-normalized: an array of { path, kind: { type }, diff }.
      const changes = Array.isArray(tool.input) ? (tool.input as unknown[]).map(rec) : [];
      if (changes.length > 0) {
        const paths = changes.map((c) => str(c.path)).filter(Boolean);
        const first = changes[0];
        const type = str(rec(first.kind).type);
        const create = type === "add";
        const remove = type === "delete";
        const d = changes.length === 1 ? parsePatchDiff(str(first.diff), create) : { adds: 0, dels: 0 };
        return finish({
          ...base,
          path: paths[0] ?? base.path,
          extraPaths: paths.slice(1),
          create,
          remove,
          adds: d.adds,
          dels: d.dels,
        });
      }
      // Raw patch text from the model.
      const text = str(i.input) || str(i.patch);
      const { files } = parseApplyPatchText(text);
      if (files.length > 0) {
        const f = files[0];
        return finish({
          ...base,
          path: f.path,
          extraPaths: files.slice(1).map((x) => x.path),
          create: f.create,
          remove: f.remove,
          adds: files.length === 1 ? f.adds : 0,
          dels: files.length === 1 ? f.dels : 0,
        });
      }
      return withPreview(base);
    }
    default: {
      const path =
        base.path ||
        str(i.file_path) ||
        str(i.path) ||
        str(i.filePath) ||
        preview?.fileName ||
        "";
      return withPreview({ ...base, path, create: kind === "write" && !preview?.deletions });
    }
  }
}

/** Basename and its directory as shown, relative to the project when inside it. */
export function splitPath(path: string, cwd?: string): { name: string; dir: string } {
  const shown = displayPath(path, cwd);
  const idx = shown.lastIndexOf("/");
  if (idx < 0) return { name: shown, dir: "" };
  const dir = shown.slice(0, idx);
  return { name: shown.slice(idx + 1), dir: dir === "." ? "" : dir };
}
