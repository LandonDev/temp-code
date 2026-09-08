import {
  createPath,
  deletePath,
  movePath,
  readTextFile,
  renamePath,
  writeTextFile,
} from "../../../lib/fs";
import { dirPrefix } from "../../../lib/tcserver/projects";
import { monaco } from "../monaco";
import {
  toMonacoRange,
  type LspPosition,
  type LspTextEdit,
  type LspWorkspaceEdit,
} from "./types";

/**
 * Workspace edits (rename, organize imports, applyEdit): open models take
 * the edits as model operations and autosave through the registry; closed
 * files inside the project root are read and written through Tauri.
 */

/** Offset for an LSP position in raw text (files with no open model). */
export function offsetAt(text: string, pos: LspPosition): number {
  let offset = 0;
  let line = 0;
  while (line < pos.line) {
    const nl = text.indexOf("\n", offset);
    if (nl < 0) return text.length;
    offset = nl + 1;
    line++;
  }
  return Math.min(offset + pos.character, text.length);
}

export function applyEditsToText(text: string, edits: LspTextEdit[]): string {
  const resolved = edits
    .map((e) => ({
      start: offsetAt(text, e.range.start),
      end: offsetAt(text, e.range.end),
      t: e.newText,
    }))
    .sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  for (const e of resolved) out = out.slice(0, e.start) + e.t + out.slice(e.end);
  return out;
}

export function applyEditsToModel(
  model: monaco.editor.ITextModel,
  edits: LspTextEdit[],
): void {
  model.pushEditOperations(
    [],
    edits.map((e) => ({ range: toMonacoRange(e.range) as monaco.Range, text: e.newText })),
    () => null,
  );
}

async function applyEditsToFile(root: string, uri: string, edits: LspTextEdit[]): Promise<void> {
  const parsed = monaco.Uri.parse(uri);
  const model = monaco.editor.getModel(parsed);
  if (model) {
    applyEditsToModel(model, edits);
    return; // an open model autosaves through the registry
  }
  if (parsed.scheme !== "file" || !parsed.path.startsWith(root)) return;
  let text: string;
  try {
    text = await readTextFile(parsed.path);
  } catch {
    return;
  }
  await writeTextFile(parsed.path, applyEditsToText(text, edits));
}

const parent = (path: string) => path.slice(0, path.lastIndexOf("/"));
const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Apply a workspace edit for the project rooted at `cwd`. */
export async function applyWorkspaceEdit(cwd: string, edit: LspWorkspaceEdit): Promise<void> {
  const root = dirPrefix(cwd);
  const inside = (uri: string): string | null => {
    const parsed = monaco.Uri.parse(uri);
    return parsed.scheme === "file" && parsed.path.startsWith(root) ? parsed.path : null;
  };
  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if ("textDocument" in change) {
        await applyEditsToFile(root, change.textDocument.uri, change.edits);
      } else if (change.kind === "create" && change.uri) {
        const path = inside(change.uri);
        if (path) await createPath(parent(path), base(path), false).catch(() => {});
      } else if (change.kind === "rename" && change.oldUri && change.newUri) {
        const from = inside(change.oldUri);
        const to = inside(change.newUri);
        if (!from || !to) continue;
        if (parent(from) === parent(to)) await renamePath(from, base(to));
        else {
          const moved = await movePath(from, parent(to));
          if (base(moved) !== base(to)) await renamePath(moved, base(to));
        }
      } else if (change.kind === "delete" && change.uri) {
        const path = inside(change.uri);
        if (path) await deletePath(path);
      }
    }
  } else if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      await applyEditsToFile(root, uri, edits);
    }
  }
}
