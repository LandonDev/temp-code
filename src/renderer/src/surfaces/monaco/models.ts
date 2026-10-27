import { readTextFile, writeTextFile, notifyGitChanged } from "../../lib/fs";
import { hostOfCwd } from "../../lib/tcserver/projects";
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
import { settleDiskRace, writeUnlessRaced } from "../../lib/diskRace";
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
 *  - the overlap → nothing is ever written over a disk change the buffer
 *    has not seen (lib/diskRace.ts): a change on other lines merges in, one
 *    on the lines being edited holds every write behind the conflict bar.
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
  /** Where the file is read and written. */
  host: string;
  model: monaco.editor.ITextModel;
  refs: number;
  /** what we believe the file on disk holds */
  diskText: string;
  savedAltId: number;
  timer: number | null;
  flushing: Promise<boolean> | null;
  /** a watch event came in during a flush: look at the disk again after it */
  recheck: boolean;
  /** the latest disk read an external change started; older ones lose */
  readSeq: number;
  /** the disk's text while state.conflict is "external" (Reload takes it) */
  theirs: string | null;
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
function applyExternal(entry: Entry, next: string, saved = true): monaco.IRange | null {
  const edit = minimalEdit(entry.model.getValue(), next);
  if (!edit) {
    if (saved) entry.savedAltId = entry.model.getAlternativeVersionId();
    return null;
  }
  const from = entry.model.getPositionAt(edit.start);
  const to = entry.model.getPositionAt(edit.endCur);
  entry.applyingExternal = true;
  try {
    // Its own undo step: ⌘Z after a Reload or a merge undoes it alone.
    entry.model.pushStackElement();
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
    entry.model.pushStackElement();
  } finally {
    entry.applyingExternal = false;
  }
  if (saved) entry.savedAltId = entry.model.getAlternativeVersionId();
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

function isDirty(entry: Entry): boolean {
  return entry.model.getAlternativeVersionId() !== entry.savedAltId;
}

/** The disk changed under the buffer. Never writes: a clean buffer takes
 *  the disk; unsaved edits on other lines get the disk's lines merged in
 *  (washed, still unsaved, so the next save writes both); edits on the same
 *  lines raise the bar. A watch event during a flush waits for it. */
async function onExternalChange(entry: Entry): Promise<void> {
  if (entry.flushing) {
    entry.recheck = true;
    return;
  }
  const seq = ++entry.readSeq;
  let disk: string;
  try {
    disk = await readTextFile(entry.host, entry.path);
  } catch {
    if (entries.get(entry.path) === entry && seq === entry.readSeq) setState(entry, { conflict: "deleted" });
    return;
  }
  if (entries.get(entry.path) !== entry || seq !== entry.readSeq) return;
  if (entry.flushing) {
    entry.recheck = true;
    return;
  }
  const race = settleDiskRace(entry.diskText, entry.model.getValue(), disk);
  switch (race.kind) {
    case "ours":
      // The disk is what we last saw: an echo of our own write, or the
      // other writer put it back. Nothing stands between the buffer and it.
      if (!entry.state.conflict) return;
      entry.theirs = null;
      setState(entry, { conflict: null });
      if (isDirty(entry)) scheduleFlush(entry);
      return;
    case "same":
      entry.diskText = disk;
      entry.savedAltId = entry.model.getAlternativeVersionId();
      setState(entry, { conflict: null, pending: false });
      return;
    case "theirs":
      entry.diskText = disk;
      applyExternal(entry, disk);
      setState(entry, { conflict: null, pending: false });
      return;
    case "merged":
      entry.diskText = disk;
      applyExternal(entry, race.text, false);
      if (entry.state.conflict) setState(entry, { conflict: null });
      scheduleFlush(entry);
      return;
    case "conflict":
      entry.theirs = disk;
      setState(entry, { conflict: "external", pending: true });
      return;
  }
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
  void onExternalChange(entry);
});

// ── save ─────────────────────────────────────────────────────────────

function wantsFormat(model: monaco.editor.ITextModel): boolean {
  const lang = model.getLanguageId();
  const setting = loadFormatOnSave();
  if (lang === "java" || lang === "kotlin") return setting.java;
  if (["typescript", "tsx", "javascript", "jsx"].includes(lang)) return setting.web;
  return false;
}

/** The disk now holds `disk`, decided on the buffer text `decidedOn`
 *  (saved at `altId`). Keystrokes typed since stay on top: unsaved, with
 *  the disk's lines merged under them when the disk took a merge, or the
 *  bar when they landed on those very lines. */
function adopt(entry: Entry, disk: string, decidedOn: string, altId: number): void {
  entry.diskText = disk;
  const now = entry.model.getValue();
  if (now === decidedOn) {
    applyExternal(entry, disk);
    return;
  }
  if (disk === decidedOn) {
    entry.savedAltId = altId;
    return;
  }
  const race = settleDiskRace(decidedOn, now, disk);
  if (race.kind === "merged") applyExternal(entry, race.text, false);
  if (race.kind === "conflict") {
    // The base stays where the buffer stands, so the write's own watch
    // echo still reads as a conflict and keeps the bar.
    entry.diskText = decidedOn;
    entry.theirs = disk;
    setState(entry, { conflict: "external", pending: true });
  }
}

/** Write the buffer if it differs from disk, unless the disk changed the
 *  lines being edited: then nothing is written and the bar asks. Resolves
 *  true when the disk holds the buffer afterwards (nothing to do counts as
 *  success). While the bar shows nothing writes but its choice (`force`). */
async function flush(entry: Entry, force = false): Promise<boolean> {
  if (entry.flushing) return entry.flushing;
  if (entry.state.conflict && !force) return false;
  if (!isDirty(entry)) {
    if (entry.state.pending) setState(entry, { pending: false });
    return true;
  }
  entry.flushing = (async () => {
    if (saveHook && wantsFormat(entry.model)) await saveHook(entry.model).catch(() => {});
    const altId = entry.model.getAlternativeVersionId();
    const content = entry.model.getValue();
    try {
      const io = {
        read: () => readTextFile(entry.host, entry.path),
        write: (text: string) => writeTextFile(entry.host, entry.path, text),
      };
      const res = await writeUnlessRaced(io, entry.diskText, content);
      if (res.kind === "conflict") {
        entry.theirs = res.theirs;
        setState(entry, { conflict: "external", pending: true });
        return false;
      }
      if (entry.state.conflict) setState(entry, { conflict: null });
      entry.theirs = null;
      adopt(entry, res.text, content, altId);
      if (res.kind === "written") {
        await syncWatchedMtime(entry.path);
        notifyGitChanged();
        for (const l of savedListeners) l(entry.model);
      }
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
  const clean = !isDirty(entry);
  if (clean && entry.state.pending) setState(entry, { pending: false });
  if (entry.recheck) {
    entry.recheck = false;
    void onExternalChange(entry);
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

// ── conflict resolution (the bar's choices) ──────────────────────────

/** Reload takes the disk's text as one undoable edit (⌘Z brings the
 *  person's text back, and the next save writes it). Keep mine, and
 *  Restore for a deleted file, write the buffer over what the disk holds
 *  now; the bar goes when the write lands. True when the disk holds the
 *  buffer afterwards. */
export async function resolveConflict(path: string, action: "reload" | "keep"): Promise<boolean> {
  const entry = entries.get(path);
  if (!entry) return true;
  if (action === "reload") {
    if (entry.state.conflict !== "external") return false;
    const disk = entry.theirs ?? entry.diskText;
    entry.theirs = null;
    entry.diskText = disk;
    if (entry.timer !== null) {
      window.clearTimeout(entry.timer);
      entry.timer = null;
    }
    applyExternal(entry, disk);
    setState(entry, { conflict: null, pending: false });
    return true;
  }
  if (entry.timer !== null) {
    window.clearTimeout(entry.timer);
    entry.timer = null;
  }
  try {
    entry.diskText = await readTextFile(entry.host, entry.path);
  } catch {
    // Deleted: the write recreates it.
  }
  if (entries.get(path) !== entry) return false;
  entry.savedAltId = -1;
  return flush(entry, true);
}

/** Save All (the menu's ⌘S): Keep mine when an editor showing this file
 *  has focus and the bar shows; otherwise a flush, which the bar holds. */
export function saveExplicit(path: string): Promise<boolean> {
  const entry = entries.get(path);
  const focused = entry && monaco.editor.getEditors().some((e) => e.getModel() === entry.model && e.hasTextFocus());
  return focused ? saveNow(path) : flushPath(path);
}

/** ⌘S: Keep mine while the bar shows, else save now. */
export function saveNow(path: string): Promise<boolean> {
  const entry = entries.get(path);
  if (entry?.state.conflict) return resolveConflict(path, "keep");
  return flushPath(path);
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

export async function openFile(path: string, cwd: string, environmentId?: string): Promise<OpenedFile> {
  let entry = entries.get(path);
  const host = environmentId ?? hostOfCwd(path);
  if (!entry) {
    let content: string;
    try {
      content = await readTextFile(host, path);
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
        host,
        model,
        refs: 0,
        diskText: content,
        savedAltId: carry === undefined ? model.getAlternativeVersionId() : -1,
        timer: null,
        flushing: null,
        recheck: false,
        readSeq: 0,
        theirs: null,
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
      created.unwatch = watchFile(path, () => void onExternalChange(created), host);
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
  return !!entry && isDirty(entry);
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
