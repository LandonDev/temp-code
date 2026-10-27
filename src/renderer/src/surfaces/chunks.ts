/**
 * The renderer's lazy chunks (lib/lazyChunk.tsx): every surface that is not
 * on the first-paint path lives behind one of these. The mount points call
 * `surface()`, the triggers spread `intent`, and `scripts/check-bundle-size.ts`
 * holds the index chunk to its budget so a stray static import cannot pull
 * one of these back in. The import targets are barrels where a chunk is
 * more than one module (editorChunk.ts, diffChunk.ts, threadViews.ts).
 */
import { defineChunk } from "../lib/lazyChunk";

/** Settings and every pane in it (SettingsView). */
export const settingsChunk = defineChunk("settings", () => import("./SettingsView"));
/** The Aliax Accounts and Stats pages, with recharts. */
export const aliaxChunk = defineChunk("aliax", () => import("./AliaxPagesView"));
/** The changes pane and the edit card's diff body (DiffPane, DiffBody). */
export const diffChunk = defineChunk("diff", () => import("./diffChunk"));
/** The CodeMirror file editor, its find/replace keys and the git helpers. */
export const editorChunk = defineChunk("editor", () => import("./editorChunk"));
/** xterm and the terminal view. */
export const terminalChunk = defineChunk("terminal", () => import("./TerminalView"));
/** The non-chat thread surfaces: the board, the plan, the research view, the fleet. */
export const threadViewsChunk = defineChunk("threadViews", () => import("./threads/threadViews"));
/** An agent's HTML page in the transcript and the overlay. */
export const htmlRenderChunk = defineChunk("htmlRender", () => import("./HtmlRenderFrame"));
/** Images, media and their review (MediaViewer). */
export const mediaChunk = defineChunk("media", () => import("./MediaViewer"));
/** The full-window image viewer. */
export const lightboxChunk = defineChunk("lightbox", () => import("../chrome/Lightbox"));
/** The release notes tab, with the bundled changelog. */
export const releaseNotesChunk = defineChunk("releaseNotes", () => import("./ReleaseNotesSurface"));
/** The thread's right panel with its section bodies (RightPanel). */
export const rightPanelChunk = defineChunk("rightPanel", () => import("./RightPanel"));

/** Every chunk, for the tests and the idle warm-up. */
export const allChunks = {
  settingsChunk,
  aliaxChunk,
  diffChunk,
  editorChunk,
  terminalChunk,
  threadViewsChunk,
  htmlRenderChunk,
  mediaChunk,
  lightboxChunk,
  releaseNotesChunk,
  rightPanelChunk,
};
