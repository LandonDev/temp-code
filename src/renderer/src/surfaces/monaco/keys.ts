import { setMonacoKeyHandler } from "../../lib/editorKeys";
import { showParamInfo } from "./lsp/paramInfo";
import type { monaco } from "./monaco";

/**
 * The live editors, so the window-level key seam can find the one that
 * has focus and run its action before the app shell's shortcuts fire.
 */
const editors = new Set<monaco.editor.ICodeEditor>();

export function trackEditor(editor: monaco.editor.ICodeEditor): () => void {
  editors.add(editor);
  return () => editors.delete(editor);
}

export function focusedEditor(): monaco.editor.ICodeEditor | null {
  for (const editor of editors) if (editor.hasTextFocus()) return editor;
  return null;
}

setMonacoKeyHandler((e) => {
  const editor = focusedEditor();
  if (!editor) return false;
  if (e.metaKey && e.key.toLowerCase() === "p") {
    void showParamInfo(editor);
    return true;
  }
  return false;
});
