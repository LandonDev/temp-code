import { readTextFile, writeTextFile, notifyGitChanged } from "../../lib/fs";
import { registerBeforeMove } from "../../lib/editorRename";
import { syncWatchedMtime, watchFile } from "../../lib/fileWatch";
import { onFileEvent, watchCwd } from "../../lib/projectWatch";
import { loadAutoSave, loadFormatOnSave } from "../../lib/settings";
import {
  getEditorState,
  setEditorState,
  type FileState,
} from "../../lib/monaco/editorState";
import { minimalEdit } from "../../lib/monaco/minimalEdit";
import { languageForPath, monaco } from "./monaco";

export { minimalEdit };

/**
 * The model registry: one buffer per absolute path, shared by every pane
 * that shows it. Disk is the source of truth and this module keeps buffers
 * and disk converging in both directions:
 *
 *  - keystrokes → 800 ms autosave (when the setting is on), ⌘S flushes now;
 *  - agent and shell writes → watch event → one minimal model edit (never
 *    setValue), so cursor, folds, and undo survive;
 *  - the overlap → the reload queues behind the flush; a true concurrent
 *    write surfaces as a one-line conflict bar, never a modal.
 */

export const AUTOSAVE_MS = 800;

type SaveHook = (model: monaco.editor.ITextModel) => Promise<void>;
let saveHook: SaveHook | null = null;
/** Formatter hook installed by the LSP layer, applied before a flush when
 *  format-on-save is on for the model's language. */
export function registerSaveHook(hook: SaveHook): void {
  saveHook = hook;
}

const savedListeners = new Set<(model: monaco.editor.ITextModel) => void>();
/** Post-save listeners (the LSP layer sends textDocument/didSave). */
export function onModelSaved(cb: (model: monaco.editor.ITextModel) => void): () => void {
  savedListeners.add(cb);
  return () => savedListeners.delete(cb);
}

interface Entry {
  path: string;
  cwd: string;
  model: monaco.editor.ITextModel;
  refs: number;
  /** what we believe the file on disk holds */
  diskText: string;
  savedAltId: number;
  timer: number | null;
  flushing: Promise<boolean> | null;
  queuedReload: boolean;
  applyingExternal: boolean;
  state: FileState;
  stateListeners: Set<(s: FileState) => void>;
  changeListeners: Set<(range: monaco.IRange) => void>;
  unwatch: () => void;
  unwatchProject: () => void;
  dispose: () => void;
}

const entries = new Map<string, Entry>();
const byUri = new Map<string, Entry>();

function setState(entry: Entry, patch: Partial<FileState>): void {
  entry.state = { ...entry.state, ...patch };
  for (const l of entry.stateListeners) l(entry.state);
  setEditorState((s) => ({ fileStates: { ...s.fileStates, [entry.path]: entry.state } }));
}

/** Apply new disk content as a minimal single edit so cursor, scroll,
 *  folds, and the undo stack survive. Returns the touched range. */
function applyExternal(entry: Entry, next: string): monaco.IRange | null {
  const edit = minimalEdit(entry.model.getValue(), next);
  if (!edit) return null;
  const from = entry.model.getPositionAt(edit.start);
  const to = entry.model.getPositionAt(edit.endCur);
  entry.applyingExternal = true;
  try {
    entry.model.pushEditOperations(
      [],
      [
        {
          range: new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column),
          text: edit.text,
        },
      ],
      () => null,
    );
  } finally {
    entry.applyingExternal = false;
  }
  entry.savedAltId = entry.model.getAlternativeVersionId();
  const endLine = entry.model.getPositionAt(edit.start + edit.text.length).lineNumber;
  const range: monaco.IRange = {
    startLineNumber: from.lineNumber,
    startColumn: 1,
    endLineNumber: Math.max(from.lineNumber, endLine),
    endColumn: 1,
  };
  for (const l of entry.changeListeners) l(range);
  return range;
}

async function reloadFromDisk(entry: Entry): Promise<void> {
  let content: string;
  try {
    content = await readTextFile(entry.path);
  } catch {
    if (entries.get(entry.path) === entry) setState(entry, { conflict: "deleted" });
    return;
  }
  if (entries.get(entry.path) !== entry) return;
  entry.diskText = content;
  applyExternal(entry, content);
  if (entry.state.conflict) setState(entry, { conflict: null });
}

function onExternalChange(entry: Entry): void {
  if (entry.state.pending || entry.flushing) {
    // Unflushed keystrokes: the window is short; reload after the flush.
    entry.queuedReload = true;
    return;
  }
  void reloadFromDisk(entry);
}

// The server's tree watcher (one subscription per project, held while a
// model is open) reports agent and shell writes; the mtime poll is the
// fallback for paths outside any project.
onFileEvent((event) => {
  const entry = entries.get(event.path);
  if (!entry) return;
  if (event.kind === "deleted") {
    setState(entry, { conflict: "deleted" });
    return;
  }
  onExternalChange(entry);
});

// ── save ─────────────────────────────────────────────────────────────

function wantsFormat(model: monaco.editor.ITextModel): boolean {
  const lang = model.getLanguageId();
  const setting = loadFormatOnSave();
  if (lang === "java" || lang === "kotlin") return setting.java;
  if (["typescript", "tsx", "javascript", "jsx"].includes(lang)) return setting.web;
  return false;
}

/** Write the buffer if it differs from disk. Resolves true when the disk
 *  holds the buffer afterwards (nothing to do counts as success). */
async function flush(entry: Entry): Promise<boolean> {
  if (entry.flushing) return entry.flushing;
  if (entry.model.getAlternativeVersionId() === entry.savedAltId) {
    if (entry.state.pending) setState(entry, { pending: false });
    return true;
  }
  entry.flushing = (async () => {
    if (saveHook && wantsFormat(entry.model)) await saveHook(entry.model).catch(() => {});
    const altId = entry.model.getAlternativeVersionId();
    const content = entry.model.getValue();
    try {
      await writeTextFile(entry.path, content);
      entry.diskText = content;
      entry.savedAltId = altId;
      await syncWatchedMtime(entry.path);
      notifyGitChanged();
      for (const l of savedListeners) l(entry.model);
      return true;
    } catch {
      // Write refused or failed: stay pending, the next flush retries.
      return false;
    }
  })();
  let ok = false;
  try {
    ok = await entry.flushing;
  } finally {
    entry.flushing = null;
  }
  const clean = entry.model.getAlternativeVersionId() === entry.savedAltId;
  if (clean && entry.state.pending) setState(entry, { pending: false });
  if (entry.queuedReload) {
    entry.queuedReload = false;
    // Re-read; if the disk differs from what we just flushed, a second
    // writer truly raced us: surface the bar instead of silently losing.
    try {
      const content = await readTextFile(entry.path);
      if (content !== entry.model.getValue()) {
        entry.diskText = content;
        setState(entry, { conflict: "external" });
      }
    } catch {
      setState(entry, { conflict: "deleted" });
    }
  }
  return ok && clean;
}

function scheduleFlush(entry: Entry): void {
  if (entry.timer !== null) window.clearTimeout(entry.timer);
  entry.timer = null;
  if (!entry.state.pending) setState(entry, { pending: true });
  if (!loadAutoSave()) return;
  entry.timer = window.setTimeout(() => {
    entry.timer = null;
    void flush(entry);
  }, AUTOSAVE_MS);
}

/** Flush every dirty buffer now (blur, close, ⌘S). */
export async function flushAll(): Promise<void> {
  await Promise.all(
    [...entries.values()].map((e) => {
      if (e.timer !== null) {
        window.clearTimeout(e.timer);
        e.timer = null;
      }
      return flush(e);
    }),
  );
}

/** Flush one path if a model is open for it; true when clean afterwards. */
export async function flushPath(path: string): Promise<boolean> {
  const entry = entries.get(path);
  if (!entry) return true;
  if (entry.timer !== null) {
    window.clearTimeout(entry.timer);
    entry.timer = null;
  }
  return flush(entry);
}

if (typeof window !== "undefined") {
  // Autosave off means nothing writes but ⌘S and the close prompt.
  window.addEventListener("blur", () => {
    if (loadAutoSave()) void flushAll();
  });
}

// ── rename / move ────────────────────────────────────────────────────

/** Dirty text carried from a moved path to its new one (autosave off). */
const carried = new Map<string, string>();

// Before the tree renames or moves a path: with autosave on the buffers
// under it flush so the re-opened tab reads the right disk text; with it
// off their dirty text follows them to the new path.
registerBeforeMove(async (from, to) => {
  for (const entry of [...entries.values()]) {
    const rest =
      entry.path === from ? "" : entry.path.startsWith(`${from}/`) ? entry.path.slice(from.length) : null;
    if (rest === null) continue;
    if (entry.timer !== null) {
      window.clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (loadAutoSave()) {
      await flush(entry);
    } else if (entry.model.getAlternativeVersionId() !== entry.savedAltId) {
      carried.set(`${to}${rest}`, entry.model.getValue());
    }
  }
});

// ── conflict resolution (the one-line bar's two actions) ─────────────

export function resolveConflict(path: string, action: "reload" | "keep"): void {
  const entry = entries.get(path);
  if (!entry) return;
  const was = entry.state.conflict;
  if (action === "reload") {
    setState(entry, { conflict: null, pending: false });
    if (was === "deleted") return;
    applyExternal(entry, entry.diskText);
    void reloadFromDisk(entry);
  } else {
    // Keep mine: the buffer wins; write it back over the disk version.
    setState(entry, { conflict: null });
    entry.savedAltId = -1;
    void flush(entry);
  }
}

// ── open / release ───────────────────────────────────────────────────

export interface OpenedFile {
  model: monaco.editor.ITextModel | null;
  /** unreadable: too large, binary, or not UTF-8 */
  unreadable: string | null;
  path: string;
  state: FileState;
  onState: (cb: (s: FileState) => void) => () => void;
  /** fires with the line range an external reload touched */
  onExternalChange: (cb: (range: monaco.IRange) => void) => () => void;
  flushNow: () => Promise<boolean>;
  release: () => void;
}

export async function openFile(path: string, cwd: string): Promise<OpenedFile> {
  let entry = entries.get(path);
  if (!entry) {
    let content: string;
    try {
      content = await readTextFile(path);
    } catch (error) {
      return {
        model: null,
        unreadable: error instanceof Error ? error.message : String(error),
        path,
        state: { pending: false, conflict: null },
        onState: () => () => {},
        onExternalChange: () => () => {},
        flushNow: async () => true,
        release: () => {},
      };
    }
    // A racing open may have created it while we awaited.
    entry = entries.get(path);
    if (!entry) {
      const uri = monaco.Uri.file(path);
      const carry = carried.get(path);
      carried.delete(path);
      const model =
        monaco.editor.getModel(uri) ??
        monaco.editor.createModel(carry ?? content, languageForPath(path), uri);
      const created: Entry = {
        path,
        cwd,
        model,
        refs: 0,
        diskText: content,
        savedAltId: carry === undefined ? model.getAlternativeVersionId() : -1,
        timer: null,
        flushing: null,
        queuedReload: false,
        applyingExternal: false,
        state: { pending: carry !== undefined, conflict: null },
        stateListeners: new Set(),
        changeListeners: new Set(),
        unwatch: () => {},
        unwatchProject: () => {},
        dispose: () => {},
      };
      const sub = model.onDidChangeContent(() => {
        if (created.applyingExternal) return;
        scheduleFlush(created);
      });
      created.unwatch = watchFile(path, () => onExternalChange(created));
      created.unwatchProject = watchCwd(cwd);
      created.dispose = () => {
        sub.dispose();
        created.unwatch();
        created.unwatchProject();
        model.dispose();
      };
      entries.set(path, created);
      byUri.set(uri.toString(), created);
      entry = created;
    }
  }
  entry.refs++;
  const theEntry = entry;
  return {
    model: theEntry.model,
    unreadable: null,
    path,
    state: theEntry.state,
    onState: (cb) => {
      theEntry.stateListeners.add(cb);
      return () => theEntry.stateListeners.delete(cb);
    },
    onExternalChange: (cb) => {
      theEntry.changeListeners.add(cb);
      return () => theEntry.changeListeners.delete(cb);
    },
    flushNow: () => {
      if (theEntry.timer !== null) {
        window.clearTimeout(theEntry.timer);
        theEntry.timer = null;
      }
      return flush(theEntry);
    },
    release: () => {
      theEntry.refs--;
      if (theEntry.refs > 0) return;
      const drop = () => {
        if (theEntry.refs > 0) return; // reopened while flushing
        if (entries.get(path) !== theEntry) return;
        entries.delete(path);
        byUri.delete(theEntry.model.uri.toString());
        theEntry.dispose();
        setEditorState((s) => {
          const fileStates = { ...s.fileStates };
          delete fileStates[path];
          const problems = { ...s.problems };
          delete problems[path];
          return { fileStates, problems };
        });
      };
      if (loadAutoSave()) void flush(theEntry).finally(drop);
      else drop();
    },
  };
}

/** Registry lookup by model URI (LSP layer, cross-file edits). */
export function entryForUri(uri: monaco.Uri): { path: string; cwd: string } | null {
  const e = byUri.get(uri.toString());
  return e ? { path: e.path, cwd: e.cwd } : null;
}

export function isModelDirty(path: string): boolean {
  const entry = entries.get(path);
  return !!entry && entry.model.getAlternativeVersionId() !== entry.savedAltId;
}

// ── problem counts (the quiet per-file count in the tab) ─────────────

monaco.editor.onDidChangeMarkers((uris) => {
  const touched = uris.some((u) => byUri.has(u.toString()));
  if (!touched) return;
  const problems: Record<string, number> = {};
  for (const [uriStr, entry] of byUri) {
    const markers = monaco.editor.getModelMarkers({ resource: monaco.Uri.parse(uriStr) });
    const n = markers.filter((m) => m.severity === monaco.MarkerSeverity.Error).length;
    if (n > 0) problems[entry.path] = n;
  }
  if (JSON.stringify(problems) !== JSON.stringify(getEditorState().problems)) {
    setEditorState({ problems });
  }
});
