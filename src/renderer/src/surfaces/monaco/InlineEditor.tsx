import { useEffect, useRef, useState } from "react";
import { MatrixSpinner } from "../threads/bits";
import { registerProviders } from "./lsp/providers";
import { openFile, type OpenedFile } from "./models";
import { EDITOR_OPTIONS, editorFontFamily, monaco, tabSizeForPath } from "./monaco";
import { monacoReady } from "./theme";

/**
 * The editor embedded in an edit row: the same model registry, autosave
 * and LSP as the file pane — height-capped, revealed at the change the row
 * is about, the model's lines washed. Lazy: Monaco loads only when a row
 * actually enters edit mode. ⌘S flushes the model and hands back to the
 * row, which re-locates its diff in the saved file.
 */
export default function InlineEditor({
  path,
  cwd,
  line,
  highlight,
  onSave,
}: {
  path: string;
  cwd: string;
  line?: number;
  highlight?: { start: number; end: number }[];
  onSave?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const initial = useRef({ line, highlight });

  useEffect(() => {
    let disposed = false;
    let handle: OpenedFile | null = null;
    let editor: monaco.editor.IStandaloneCodeEditor | null = null;
    void (async () => {
      try {
        await monacoReady();
        registerProviders();
        handle = await openFile(path, cwd);
      } catch (e) {
        if (!disposed) {
          setError(e instanceof Error ? e.message : String(e));
          setPhase("error");
        }
        return;
      }
      if (disposed || !host.current) {
        handle.release();
        return;
      }
      if (!handle.model) {
        setError(handle.unreadable ?? "Can't open this file");
        setPhase("error");
        return;
      }
      const opened = handle;
      const model = handle.model;
      model.updateOptions({ tabSize: tabSizeForPath(path), insertSpaces: true });
      editor = monaco.editor.create(host.current, {
        ...EDITOR_OPTIONS,
        fontFamily: editorFontFamily(),
        model,
      });
      const { line: at, highlight: ranges } = initial.current;
      if (ranges?.length) {
        editor.createDecorationsCollection(
          ranges.map((r) => ({
            range: new monaco.Range(r.start, 1, r.end, 1),
            options: { isWholeLine: true, className: "model-change-line" },
          })),
        );
      }
      if (at) {
        editor.setPosition({ lineNumber: at, column: 1 });
        editor.revealLineInCenter(at);
      }
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        void opened.flushNow().then(() => onSaveRef.current?.());
      });
      editor.focus();
      setPhase("ready");
    })();
    return () => {
      disposed = true;
      editor?.dispose();
      handle?.release();
    };
  }, [path, cwd]);

  return (
    <div className="relative h-80">
      <div ref={host} className="absolute inset-0" />
      {phase === "loading" ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <MatrixSpinner />
        </div>
      ) : phase === "error" ? (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-content/50">
          {error}
        </div>
      ) : null}
    </div>
  );
}
