import { useEffect, useRef, useState } from "react";
import { loadToast } from "../../components/ui/toaster";
import { registerEditorFlusher } from "../../lib/editorFlush";
import { gitFileDiff, gitStageContents, notifyGitChanged, subscribeGitChanged } from "../../lib/fs";
import type { FileState } from "../../lib/monaco/editorState";
import { displayPath } from "../../lib/paths";
import { registry } from "../../lib/connection";
import { hostOfCwd, projectForCwd } from "../../lib/tcserver/projects";
import { SurfaceSkeleton } from "../SurfaceSkeleton";
import { FileHeader, fileFolder } from "../FileHeader";
import { ConflictBar } from "../ConflictBar";
import { changeLineOffsets, changeOffset, minimalEdit, positionAt } from "./diffActions";
import { trackEditor } from "./keys";
import { ensureForModel } from "./lsp/idea";
import { registerProviders } from "./lsp/providers";
import { EDITOR_OPTIONS, editorFontFamily, followEditorFont, languageForPath, monaco } from "./monaco";
import { openFile, resolveConflict, saveExplicit, saveNow, type OpenedFile } from "./models";
import { monacoReady } from "./theme";

/**
 * The text a review compares against: `base` (a ref; HEAD when unset) at
 * the project, empty for an untracked path. Outside any project the git
 * diff bridge answers instead.
 */
async function baseText(path: string, cwd: string, base?: string): Promise<string> {
  const relative = displayPath(path, cwd);
  const project = projectForCwd(cwd);
  if (project) {
    const text = await registry.linkOf(project.environmentId)
      .request<string | null>("project.show", { projectId: project.id, path: relative, ref: base })
      .catch(() => null);
    return text ?? "";
  }
  const diff = await gitFileDiff(hostOfCwd(path), cwd, relative).catch(() => null);
  return diff && !diff.binary && !diff.tooLarge ? diff.original : "";
}

/** The index's text of a path, what Stage builds on; null when git cannot say. */
async function indexText(path: string, cwd: string): Promise<string | null> {
  const diff = await gitFileDiff(hostOfCwd(path), cwd, displayPath(path, cwd)).catch(() => null);
  return diff && !diff.binary && !diff.tooLarge ? diff.original : null;
}

/** editorGit's chunk functions live in the editor chunk; Monaco's reaches them on use. */
const loadEditorGit = () => import("../editorGit");

/**
 * A review tab in Monaco: the base on the left, the live model on the
 * right — the same registry buffer as a file tab, so it autosaves, ⌘S
 * flushes, dirtiness reaches the tab, and a disk race shows the bar. It
 * opens on the first change; the header's Revert and Stage act on the
 * change the caret is in (Stage only for a review against HEAD, built on
 * the index as the Changes section stages a hunk).
 */
export function DiffSurface({
  path,
  cwd,
  base,
  onDirtyChange,
}: {
  path: string;
  cwd: string;
  base?: string;
  onDirtyChange?: (path: string, dirty: boolean) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const modifiedRef = useRef<monaco.editor.ICodeEditor | null>(null);
  const originalRef = useRef<monaco.editor.ITextModel | null>(null);
  const [index, setIndex] = useState<string | null>(null);
  const [staged, setStaged] = useState(false);
  const [busy, setBusy] = useState(false);
  // Stage is offered against HEAD only, for a path inside the checkout.
  const relative = displayPath(path, cwd);
  const stageable = !base && relative !== path;
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [fileState, setFileState] = useState<FileState>({ pending: false, conflict: null });
  const [changes, setChanges] = useState<monaco.editor.ILineChange[]>([]);
  const [changeIndex, setChangeIndex] = useState(0);
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;

  useEffect(() => {
    onDirtyChangeRef.current?.(path, fileState.pending);
  }, [path, fileState.pending]);

  useEffect(() => {
    let disposed = false;
    let handle: OpenedFile | null = null;
    let editor: monaco.editor.IStandaloneDiffEditor | null = null;
    let original: monaco.editor.ITextModel | null = null;
    const cleanups: (() => void)[] = [];
    void (async () => {
      try {
        await monacoReady();
        registerProviders();
        const [head, opened] = await Promise.all([baseText(path, cwd, base), openFile(path, cwd)]);
        if (disposed) {
          opened.release();
          return;
        }
        handle = opened;
        if (!opened.model) {
          setPhase("error");
          return;
        }
        setFileState(opened.state);
        cleanups.push(opened.onState(setFileState));
        cleanups.push(
          registerEditorFlusher(path, (explicit) =>
            explicit ? saveExplicit(path) : opened.flushNow(),
          ),
        );
        original = monaco.editor.createModel(head, languageForPath(path));
        originalRef.current = original;
        editor = monaco.editor.createDiffEditor(hostRef.current!, {
          ...EDITOR_OPTIONS,
          fontFamily: editorFontFamily(),
          renderSideBySide: true,
          useInlineViewWhenSpaceIsLimited: true,
          originalEditable: false,
          renderOverviewRuler: false,
          diffAlgorithm: "advanced",
        });
        editor.setModel({ original, modified: opened.model });
        cleanups.push(followEditorFont(editor));
        const modified = editor.getModifiedEditor();
        cleanups.push(trackEditor(modified));
        modified.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveNow(path));
        modifiedRef.current = modified;
        // The first diff with changes lands the caret on the first one, unless the person moved it since the open.
        const opening = modified.getPosition();
        let landed = false;
        const syncChanges = () => {
          const next = editor?.getLineChanges() ?? [];
          let line = modified.getPosition()?.lineNumber ?? 1;
          if (!landed && next.length > 0) {
            landed = true;
            const at = modified.getPosition();
            if (!at || !opening || (at.lineNumber === opening.lineNumber && at.column === opening.column)) {
              line = Math.max(1, next[0].modifiedStartLineNumber);
              modified.setPosition({ lineNumber: line, column: 1 });
              modified.revealLineInCenter(line);
            }
          }
          setChanges(next);
          // -1 while the caret is above the first change, so Next reaches it.
          setChangeIndex(next.findLastIndex((change) => Math.max(1, change.modifiedStartLineNumber) <= line));
        };
        // A caret placed in the base's pane names the change there, so Revert and Stage act on what was clicked.
        const basePane = editor.getOriginalEditor();
        const syncFromBase = () => {
          const line = basePane.getPosition()?.lineNumber ?? 1;
          const next = editor?.getLineChanges() ?? [];
          setChangeIndex(next.findLastIndex((change) => Math.max(1, change.originalStartLineNumber) <= line));
        };
        // Focus moving between the panes moves the target too, with no caret move to say so.
        cleanups.push(
          () => diffListener.dispose(),
          () => cursorListener.dispose(),
          () => baseListener.dispose(),
          () => baseFocus.dispose(),
          () => modifiedFocus.dispose(),
        );
        const baseListener = basePane.onDidChangeCursorPosition(syncFromBase);
        const baseFocus = basePane.onDidFocusEditorText(syncFromBase);
        const modifiedFocus = modified.onDidFocusEditorText(syncChanges);
        const diffListener = editor.onDidUpdateDiff(syncChanges);
        const cursorListener = modified.onDidChangeCursorPosition(syncChanges);
        syncChanges();
        const project = projectForCwd(cwd);
        if (project) ensureForModel(project, opened.model);
        setPhase("ready");
      } catch {
        if (!disposed) setPhase("error");
      }
    })();
    return () => {
      disposed = true;
      for (const cleanup of cleanups) cleanup();
      modifiedRef.current = null;
      originalRef.current = null;
      editor?.dispose();
      original?.dispose();
      handle?.release();
      setPhase("loading");
      setChanges([]);
      setChangeIndex(0);
    };
  }, [path, cwd, base]);

  useEffect(() => {
    if (!stageable) return;
    let live = true;
    const load = () =>
      void indexText(path, cwd).then((text) => {
        if (live) setIndex(text);
      });
    load();
    // A stage or unstage elsewhere (the Changes section) moves the index under the review.
    const off = subscribeGitChanged(load, cwd);
    return () => {
      live = false;
      off();
      setIndex(null);
    };
  }, [path, cwd, stageable]);

  // Stage is off for a change the index already has.
  const current = changes[changeIndex];
  useEffect(() => {
    const model = modifiedRef.current?.getModel();
    if (!stageable || index === null || !current || !model) {
      setStaged(false);
      return;
    }
    let live = true;
    void loadEditorGit().then(({ stageChunkText }) => {
      const text = model.getValue(monaco.editor.EndOfLinePreference.LF);
      if (live) setStaged(changeLineOffsets(text, current).every((at) => stageChunkText(index, text, at) === null));
    });
    return () => {
      live = false;
    };
  }, [stageable, index, current]);

  const revert = async () => {
    const modified = modifiedRef.current;
    const model = modified?.getModel();
    const original = originalRef.current;
    if (!current || !modified || !model || !original) return;
    const { revertChunkText } = await loadEditorGit();
    const text = model.getValue(monaco.editor.EndOfLinePreference.LF);
    const next = revertChunkText(original.getValue(monaco.editor.EndOfLinePreference.LF), text, changeOffset(text, current));
    if (next === null) return;
    // One undoable edit over just the span that changes, so the caret stays put.
    const edit = minimalEdit(text, next);
    const from = positionAt(text, edit.start);
    const to = positionAt(text, edit.end);
    model.pushStackElement();
    model.pushEditOperations(
      null,
      [{ range: { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column }, text: edit.insert }],
      () => null,
    );
    model.pushStackElement();
    modified.focus();
  };

  const stage = async () => {
    const model = modifiedRef.current?.getModel();
    if (!current || !model || busy) return;
    setBusy(true);
    try {
      const [{ stageChunkText }, fresh] = await Promise.all([loadEditorGit(), indexText(path, cwd)]);
      if (fresh === null) throw new Error("Git could not read this file's index");
      const text = model.getValue(monaco.editor.EndOfLinePreference.LF);
      // Every part of the change the index lacks, applied in turn: a change partly staged stages the rest whole.
      const staged = changeLineOffsets(text, current).reduce((index, at) => stageChunkText(index, text, at) ?? index, fresh);
      const contents = staged === fresh ? null : staged;
      if (contents !== null) {
        await gitStageContents(hostOfCwd(path), cwd, relative, contents);
        notifyGitChanged();
      }
      setIndex(contents ?? fresh);
      // The base is read again: a review the index moved under shows where it stands now.
      const head = await baseText(path, cwd, base);
      const original = originalRef.current;
      if (original && original.getValue() !== head) original.setValue(head);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void loadToast().then((toast) => toast.error(`Couldn't stage the change: ${message}`));
    } finally {
      setBusy(false);
      modifiedRef.current?.focus();
    }
  };

  const stepToChange = (delta: -1 | 1) => {
    const index = Math.max(0, Math.min(changes.length - 1, changeIndex + delta));
    const change = changes[index];
    const modified = modifiedRef.current;
    if (!change || !modified) return;
    const lineNumber = Math.max(1, change.modifiedStartLineNumber);
    modified.setPosition({ lineNumber, column: 1 });
    modified.revealLineInCenter(lineNumber);
    modified.focus();
    setChangeIndex(index);
  };

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col">
      {fileState.conflict ? (
        <ConflictBar
          kind={fileState.conflict}
          onReload={() => {
            void resolveConflict(path, "reload");
            modifiedRef.current?.focus();
          }}
          onKeep={() => {
            void resolveConflict(path, "keep");
            modifiedRef.current?.focus();
          }}
        />
      ) : null}
      <FileHeader
        folder={fileFolder(path, cwd)}
        diff={{
          additions: changes.reduce((sum, change) => sum + (change.modifiedEndLineNumber === 0 ? 0 : change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1), 0),
          deletions: changes.reduce((sum, change) => sum + (change.originalEndLineNumber === 0 ? 0 : change.originalEndLineNumber - change.originalStartLineNumber + 1), 0),
          index: changeIndex,
          total: changes.length,
          onPrev: () => stepToChange(-1),
          onNext: () => stepToChange(1),
          ...(phase === "ready" ? { onRevert: () => void revert(), ...(stageable ? { onStage: () => void stage() } : {}) } : {}),
          staged: staged || (stageable && index === null),
          busy,
        }}
      />
      {phase === "loading" ? (
        <div className="flex min-h-0 flex-1">
          <SurfaceSkeleton kind="diff" label="Loading file" />
        </div>
      ) : null}
      {phase === "error" ? (
        <div className="flex flex-1 items-center justify-center text-[12px] text-muted-foreground">
          Could not open this diff.
        </div>
      ) : null}
      <div
        ref={hostRef}
        className="min-h-0 flex-1"
        style={{ display: phase === "ready" ? undefined : "none" }}
      />
    </div>
  );
}
