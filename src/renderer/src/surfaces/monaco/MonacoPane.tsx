import { useEffect, useRef, useState } from "react";
import { registerEditorFlusher } from "../../lib/editorFlush";
import { requestDebugTab, requestSettings } from "../../lib/monaco/debugTab";
import { useEditorState, type FileState } from "../../lib/monaco/editorState";
import { setFileOpener } from "../../lib/monaco/opener";
import { toggleBreakpoint } from "../../lib/monaco/breakpoints";
import type { EditorNavigationTarget, OpenFileFn } from "../../lib/search";
import { projectForCwd } from "../../lib/tcserver/projects";
import { MatrixSpinner } from "../threads/bits";
import { DiffSurface } from "./DiffSurface";
import { attachGitGutter } from "./gitGutter";
import { ideaNeedsEula } from "./lsp/connection";
import { ensureForModel } from "./lsp/idea";
import { installSmartBackspace, showParamInfo } from "./lsp/paramInfo";
import { registerProviders, showHierarchy } from "./lsp/providers";
import { debugFile, paintBreakpoints } from "./debug/session";
import { EDITOR_OPTIONS, editorFontFamily, monaco, tabSizeForPath } from "./monaco";
import { openFile, resolveConflict, type OpenedFile } from "./models";
import { monacoReady } from "./theme";

type Props = {
  path: string;
  cwd: string;
  active: boolean;
  showDiff?: boolean;
  navigation?: EditorNavigationTarget | null;
  onDirtyChange: (path: string, dirty: boolean) => void;
  onErrorCountChange?: (path: string, count: number) => void;
  onOpenFile?: OpenFileFn;
};

/** Scroll and cursor state per path, restored across tab switches. */
const viewStates = new Map<string, monaco.editor.ICodeEditorViewState>();

/**
 * One Monaco editor over one registry model, with FileEditor's prop
 * contract. The buffer is the hero: no chrome beyond the one-line conflict
 * bar and a status line while the language server indexes.
 */
export default function MonacoPane(props: Props) {
  const { path, cwd, active, showDiff = false, navigation, onDirtyChange, onErrorCountChange, onOpenFile } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "unreadable" | "error">("loading");
  const [unreadable, setUnreadable] = useState<string | null>(null);
  const [fileState, setFileState] = useState<FileState>({ pending: false, conflict: null });
  const [needsEula, setNeedsEula] = useState(false);
  const project = projectForCwd(cwd);
  const busy = useEditorState((s) => (project ? (s.lspBusy[project.id] ?? null) : null));
  const problems = useEditorState((s) => s.problems[path] ?? 0);
  const onOpenFileRef = useRef(onOpenFile);
  const onDirtyChangeRef = useRef(onDirtyChange);
  const onErrorCountChangeRef = useRef(onErrorCountChange);
  onOpenFileRef.current = onOpenFile;
  onDirtyChangeRef.current = onDirtyChange;
  onErrorCountChangeRef.current = onErrorCountChange;

  useEffect(() => {
    onDirtyChangeRef.current(path, fileState.pending);
  }, [path, fileState.pending]);

  useEffect(() => {
    onErrorCountChangeRef.current?.(path, problems);
    return () => onErrorCountChangeRef.current?.(path, 0);
  }, [path, problems]);

  // The latest active pane owns cross-file navigation (goto definition,
  // usages, the debugger's top frame).
  useEffect(() => {
    if (active && onOpenFile) setFileOpener(onOpenFile);
  }, [active, onOpenFile]);

  useEffect(() => {
    if (active && phase === "ready") editorRef.current?.focus();
  }, [active, phase]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || phase !== "ready" || !navigation) return;
    const position = { lineNumber: navigation.line, column: navigation.column ?? 1 };
    editor.setPosition(position);
    editor.revealPositionInCenterIfOutsideViewport(position);
    editor.focus();
    const flash = editor.createDecorationsCollection([
      {
        range: new monaco.Range(position.lineNumber, 1, position.lineNumber, 1),
        options: { isWholeLine: true, className: "reveal-flash-line" },
      },
    ]);
    const timer = window.setTimeout(() => flash.clear(), 2000);
    return () => window.clearTimeout(timer);
  }, [navigation, phase]);

  useEffect(() => {
    if (showDiff) return;
    let disposed = false;
    let handle: OpenedFile | null = null;
    let editor: monaco.editor.IStandaloneCodeEditor | null = null;
    const cleanups: (() => void)[] = [];
    void (async () => {
      try {
        await monacoReady();
        registerProviders();
        handle = await openFile(path, cwd);
      } catch {
        if (!disposed) setPhase("error");
        return;
      }
      if (disposed) {
        handle.release();
        return;
      }
      if (!handle.model) {
        setUnreadable(handle.unreadable);
        setPhase("unreadable");
        return;
      }
      const model = handle.model;
      const opened = handle;
      setFileState(opened.state);
      cleanups.push(opened.onState(setFileState));
      cleanups.push(registerEditorFlusher(path, opened.flushNow));
      const debuggable = ["java", "kotlin"].includes(model.getLanguageId());
      model.updateOptions({ tabSize: tabSizeForPath(path), insertSpaces: true });
      editor = monaco.editor.create(hostRef.current!, {
        ...EDITOR_OPTIONS,
        fontFamily: editorFontFamily(),
        model,
        glyphMargin: debuggable,
      });
      editorRef.current = editor;
      const saved = viewStates.get(path);
      if (saved) editor.restoreViewState(saved);

      // Agent edits arrive through the watcher as one minimal edit; wash
      // the touched lines so the change is visible without a diff.
      cleanups.push(
        opened.onExternalChange((range) => {
          const wash = editor?.createDecorationsCollection([
            { range: new monaco.Range(range.startLineNumber, 1, range.endLineNumber, 1), options: { isWholeLine: true, className: "model-change-line" } },
          ]);
          window.setTimeout(() => wash?.clear(), 1500);
        }),
      );

      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void opened.flushNow());
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, () => {
        if (editor) void showParamInfo(editor);
      });
      installSmartBackspace(editor);
      editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.Enter, () => {
        editor?.trigger("keyboard", "editor.action.quickFix", null);
      });
      editor.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyCode.KeyT, () => {
        editor?.trigger("keyboard", "editor.action.refactor", null);
      });
      editor.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyMod.Alt | monaco.KeyCode.KeyH, () => {
        if (editor) void showHierarchy(editor, "callers");
      });
      editor.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyCode.KeyH, () => {
        if (editor) void showHierarchy(editor, "types");
      });
      // WKWebView blocks execCommand('paste'); read the clipboard ourselves.
      editor.addAction({
        id: "mc.paste",
        label: "Paste",
        contextMenuGroupId: "9_cutcopypaste",
        contextMenuOrder: 3,
        run: async (ed) => {
          const text = await navigator.clipboard.readText().catch(() => "");
          if (text) ed.trigger("keyboard", "type", { text });
        },
      });

      if (debuggable) {
        paintBreakpoints(editor, path);
        editor.onMouseDown((e) => {
          if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && e.target.position) {
            toggleBreakpoint(path, e.target.position.lineNumber);
            if (editor) paintBreakpoints(editor, path);
          }
        });
        const launch = () => {
          if (!project) return;
          requestDebugTab(cwd, path);
          void debugFile(project, path, model.getValue());
        };
        editor.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyCode.KeyD, launch);
        editor.addAction({
          id: "mc.debugFile",
          label: "Debug this file",
          contextMenuGroupId: "navigation",
          contextMenuOrder: 9,
          run: launch,
        });
      }

      cleanups.push(attachGitGutter(editor, path, cwd));
      if (project) {
        ensureForModel(project, model);
        if (debuggable) {
          // The engine's ensure settles quickly when the EULA gate is up.
          window.setTimeout(() => {
            if (!disposed) setNeedsEula(ideaNeedsEula(project.id));
          }, 1500);
        }
      }
      setPhase("ready");
    })();
    return () => {
      disposed = true;
      for (const cleanup of cleanups) cleanup();
      if (editor) {
        const vs = editor.saveViewState();
        if (vs) viewStates.set(path, vs);
        editor.dispose();
      }
      editorRef.current = null;
      handle?.release();
      setPhase("loading");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- remount per path; the parent keys us
  }, [path, cwd, showDiff]);

  if (showDiff) return <DiffSurface path={path} cwd={cwd} />;

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col">
      {fileState.conflict ? (
        <ConflictBar
          kind={fileState.conflict}
          onReload={() => resolveConflict(path, "reload")}
          onKeep={() => resolveConflict(path, "keep")}
        />
      ) : null}
      {needsEula && project ? (
        <div className="flex h-8 shrink-0 items-center gap-3 border-b border-content/10 px-3 text-[12px]">
          <span className="text-content/60">IntelliJ engine needs the EULA</span>
          <span className="flex-1" />
          <button type="button" className="font-medium text-content hover:underline" onClick={() => requestSettings("editor")}>
            Accept
          </button>
        </div>
      ) : null}
      {phase === "loading" ? (
        <div className="flex flex-1 items-center justify-center">
          <MatrixSpinner />
        </div>
      ) : null}
      {phase === "unreadable" ? (
        <Stub text={unreadable ?? "Could not read this file."} />
      ) : null}
      {phase === "error" ? <Stub text="Could not read this file." /> : null}
      <div ref={hostRef} className="min-h-0 flex-1" style={{ display: phase === "ready" ? undefined : "none" }} />
      {busy && phase === "ready" ? (
        <div className="pointer-events-none absolute right-3 bottom-2 text-[11px] text-content/45 tabular-nums">
          {busy}
        </div>
      ) : null}
    </div>
  );
}

function Stub({ text }: { text: string }) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 text-center text-[12px] text-content/50">
      {text}
    </div>
  );
}

/** The honest escape hatch: one line, two words each, no modal. */
function ConflictBar({
  kind,
  onReload,
  onKeep,
}: {
  kind: "external" | "deleted";
  onReload: () => void;
  onKeep: () => void;
}) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-3 border-b border-content/10 bg-warning/10 px-3 text-[12px]">
      <span className="text-content/60">
        {kind === "external" ? "Changed on disk while you were typing" : "Deleted on disk"}
      </span>
      <span className="flex-1" />
      {kind === "external" ? (
        <button type="button" onClick={onReload} className="font-medium hover:underline">
          reload
        </button>
      ) : null}
      {kind === "external" ? <span className="text-content/30">·</span> : null}
      <button type="button" onClick={onKeep} className="font-medium hover:underline">
        keep mine
      </button>
    </div>
  );
}
