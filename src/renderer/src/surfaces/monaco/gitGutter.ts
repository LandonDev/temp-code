import { Chunk } from "@codemirror/merge";
import { Text } from "@codemirror/state";
import { gutterMarks, type GutterMark } from "../../lib/monaco/gutterMarks";
import { gitFileDiff, subscribeGitChanged } from "../../lib/fs";
import { displayPath } from "../../lib/paths";
import { monaco } from "./monaco";

/**
 * The git gutter for normal Monaco tabs: added, changed, and deleted line
 * marks against HEAD, in the same colours as the CodeMirror review tab.
 * The HEAD text comes from `git_file_diff` (Tauri); chunks from
 * @codemirror/merge's diff, the same chunk model editorGit.ts uses.
 */

const DIFF_CONFIG = { scanLimit: 5_000, timeout: 100 };

const CLASS: Record<GutterMark["kind"], string> = {
  add: "mc-git-add",
  change: "mc-git-change",
  delete: "mc-git-delete",
};

/** Paint and keep the gutter current; returns a disposer. */
export function attachGitGutter(
  editor: monaco.editor.ICodeEditor,
  path: string,
  cwd: string,
): () => void {
  const relative = displayPath(path, cwd);
  if (!cwd || cwd === "~" || relative === path) return () => {};
  const coll = editor.createDecorationsCollection();
  let original: string | null = null;
  let disposed = false;
  let timer: number | null = null;

  const paint = () => {
    const model = editor.getModel();
    if (!model || original === null) {
      coll.clear();
      return;
    }
    const current = Text.of(model.getValue().split("\n"));
    const chunks = Chunk.build(Text.of(original.split("\n")), current, DIFF_CONFIG);
    coll.set(
      gutterMarks(chunks, current).map((mark) => ({
        range: new monaco.Range(mark.line, 1, mark.line, 1),
        options: { linesDecorationsClassName: CLASS[mark.kind] },
      })),
    );
  };

  const refresh = async () => {
    try {
      const diff = await gitFileDiff(cwd, relative);
      // Untracked files get no marks; the whole file would be green.
      original = diff.binary || diff.tooLarge || diff.status === "untracked" ? null : diff.original;
    } catch {
      original = null;
    }
    if (!disposed) paint();
  };

  const schedule = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      paint();
    }, 300);
  };

  void refresh();
  const subs = [
    editor.onDidChangeModelContent(schedule),
    subscribeGitChanged(() => void refresh()),
  ];
  const onFocus = () => void refresh();
  window.addEventListener("focus", onFocus);
  return () => {
    disposed = true;
    if (timer !== null) window.clearTimeout(timer);
    for (const sub of subs) typeof sub === "function" ? sub() : sub.dispose();
    window.removeEventListener("focus", onFocus);
    coll.clear();
  };
}
