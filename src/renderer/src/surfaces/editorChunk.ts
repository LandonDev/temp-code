/** The editor chunk's barrel (surfaces/chunks.ts editorChunk): CodeMirror,
 *  the file editor, and the find keys App.tsx dispatches to the active
 *  editor (editorFind.ts delegates here once the chunk is loaded). */
export { FileEditor } from "./FileEditor";
export { handleEditorFindKey, openFindInActiveEditor } from "./editorSearch";
