import { useEffect, useRef, useState } from "react";
import { gitFileDiff } from "../../lib/fs";
import { displayPath } from "../../lib/paths";
import { projectForCwd } from "../../lib/tcserver/projects";
import { MatrixSpinner } from "../threads/bits";
import { EDITOR_OPTIONS, editorFontFamily, languageForPath, monaco } from "./monaco";
import { ensureForModel } from "./lsp/idea";
import { openFile, type OpenedFile } from "./models";

/**
 * A review tab in Monaco: HEAD on the left, the live model on the right,
 * editable and autosaving through the same registry as any file tab.
 */
export function DiffSurface({ path, cwd }: { path: string; cwd: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let disposed = false;
    let handle: OpenedFile | null = null;
    let editor: monaco.editor.IStandaloneDiffEditor | null = null;
    let original: monaco.editor.ITextModel | null = null;
    void (async () => {
      try {
        const relative = displayPath(path, cwd);
        const [diff, opened] = await Promise.all([
          gitFileDiff(cwd, relative).catch(() => null),
          openFile(path, cwd),
        ]);
        handle = opened;
        if (disposed || !opened.model) {
          if (!disposed) setPhase("error");
          return;
        }
        // Untracked or unreadable HEAD: diff against empty.
        const head = diff && !diff.binary && !diff.tooLarge ? diff.original : "";
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
        const project = projectForCwd(cwd);
        if (project) ensureForModel(project, opened.model);
        setPhase("ready");
      } catch {
        if (!disposed) setPhase("error");
      }
    })();
    return () => {
      disposed = true;
      editor?.dispose();
      original?.dispose();
      handle?.release();
    };
  }, [path, cwd]);

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col">
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
