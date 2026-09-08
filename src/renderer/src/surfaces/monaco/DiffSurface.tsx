import { useEffect, useRef, useState } from "react";
import { registerEditorFlusher } from "../../lib/editorFlush";
import { gitFileDiff } from "../../lib/fs";
import type { FileState } from "../../lib/monaco/editorState";
import { displayPath } from "../../lib/paths";
import { client } from "../../lib/tcserver/client";
import { projectForCwd } from "../../lib/tcserver/projects";
import { MatrixSpinner } from "../threads/bits";
import { ConflictBar } from "./ConflictBar";
import { trackEditor } from "./keys";
import { ensureForModel } from "./lsp/idea";
import { registerProviders } from "./lsp/providers";
import { EDITOR_OPTIONS, editorFontFamily, languageForPath, monaco } from "./monaco";
import { openFile, resolveConflict, type OpenedFile } from "./models";
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
    const text = await client
      .request<string | null>("project.show", { projectId: project.id, path: relative, ref: base })
      .catch(() => null);
    return text ?? "";
  }
  const diff = await gitFileDiff(cwd, relative).catch(() => null);
  return diff && !diff.binary && !diff.tooLarge ? diff.original : "";
}

/**
 * A review tab in Monaco: the base on the left, the live model on the
 * right — the same registry buffer as a file tab, so it autosaves, ⌘S
 * flushes, dirtiness reaches the tab, and a disk race shows the bar.
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
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [fileState, setFileState] = useState<FileState>({ pending: false, conflict: null });
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
        cleanups.push(registerEditorFlusher(path, opened.flushNow));
        original = monaco.editor.createModel(head, languageForPath(path));
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
        const modified = editor.getModifiedEditor();
        cleanups.push(trackEditor(modified));
        modified.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void opened.flushNow());
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
      editor?.dispose();
      original?.dispose();
      handle?.release();
      setPhase("loading");
    };
  }, [path, cwd, base]);

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col">
      {fileState.conflict ? (
        <ConflictBar
          kind={fileState.conflict}
          onReload={() => resolveConflict(path, "reload")}
          onKeep={() => resolveConflict(path, "keep")}
        />
      ) : null}
      {phase === "loading" ? (
        <div className="flex flex-1 items-center justify-center">
          <MatrixSpinner />
        </div>
      ) : null}
      {phase === "error" ? (
        <div className="flex flex-1 items-center justify-center text-[12px] text-content/50">
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
