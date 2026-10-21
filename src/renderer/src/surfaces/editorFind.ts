import { editorChunk } from "./chunks";

/**
 * The find keys the window dispatches to the active CodeMirror editor
 * (editorSearch.ts), reached through the editor chunk: an editor can only
 * be mounted once the chunk has loaded, so before that no key is an
 * editor's and the answer is false without loading anything.
 */
export function handleEditorFindKey(event: KeyboardEvent): boolean {
  return editorChunk.loaded()?.handleEditorFindKey(event) ?? false;
}

export function openFindInActiveEditor(): boolean {
  return editorChunk.loaded()?.openFindInActiveEditor() ?? false;
}
