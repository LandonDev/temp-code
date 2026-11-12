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
/** The edit card's diff body (DiffBody). */
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
/** The full-body search view with its filter menu (SearchView). */
export const searchChunk = defineChunk("search", () => import("./SearchView"));
/** The inbox view and the classic layout's detail pane (InboxView, InboxDetailPane). */
export const inboxChunk = defineChunk("inbox", () => import("./InboxView"));
/** The all-notes view (NotesView, focusNote). */
export const notesChunk = defineChunk("notes", () => import("./NotesView"));
/** Every select on the Base UI select: the dialogs' and settings' ChoiceSelect, and the composer's
 *  permission, thread type and model setting pickers (components/select-body.ts, components/lazy-select.tsx). */
export const selectChunk = defineChunk("select", () => import("../components/select-body"));

/** The accounts a failure card's Pick another account lists (chrome/AccountsList.tsx). */
export const accountsChunk = defineChunk("accounts", () => import("../chrome/AccountsList"));

/** A workspace's threads beside the rail, opened from its row's mark (chrome/WorkspaceThreadsPopover.tsx). */
export const workspaceThreadsChunk = defineChunk("workspaceThreads", () => import("../chrome/WorkspaceThreadsPopover"));

/** Every menu, context menu and popover's body (chrome/menuBody.tsx); chrome/menuRows.tsx swaps them in. */
export const menuChunk = defineChunk("menus", () => import("../chrome/menuBody"));

/** A project's or tab group's Customize dialog, opened from its menu (CustomizeGroupDialog). */
export const customizeChunk = defineChunk("customize", () => import("../chrome/CustomizeGroupDialog"));

/** The dialogs an action opens: new project or workspace, project settings and
 *  teardown, a remote folder, thread defaults, the preamble, What's new and
 *  the fleet switches' confirm (chrome/dialogs.ts). */
export const dialogsChunk = defineChunk("dialogs", () => import("../chrome/dialogs"));

/** The composer's slash and @ menu (chrome/CommandPopover.tsx), mounted once a composer first has matches and warmed in the idle slot. */
export const commandMenuChunk = defineChunk("commandMenu", () => import("../chrome/CommandPopover"));

/** The file and symbol pickers, mounted while open (chrome/pickers.ts). */
export const pickersChunk = defineChunk("pickers", () => import("../chrome/pickers"));

/** A box thread's waiting Mac bridge card above its composer (chrome/MacBridgeThreadCards.tsx). */
export const macBridgeChunk = defineChunk("macBridge", () => import("../chrome/MacBridgeThreadCards"));

/** The return from Away (chrome/AwayReturn.tsx): its listener, toast and list, mounted at boot and loaded after the first paint. */
export const awayReturnChunk = defineChunk("awayReturn", () => import("../chrome/AwayReturn"));

/** The rail's virtualizer (@tanstack/react-virtual); the rail lists its cards plainly until it lands. */
export const virtualChunk = defineChunk("virtual", () => import("../chrome/railVirtualRows"));

/** The transcript's message list rows under their chevron (TranscriptOutlineList.tsx). */
export const messageListChunk = defineChunk("messageList", () => import("./TranscriptOutlineList"));
/** A review's notice in the transcript: its line, or the held review's card (ReviewCard). */
export const reviewChunk = defineChunk("review", () => import("./ReviewCard"));

/** The right panel's Computer section: the window live or as it was, and the thread's steps (threads/computer/). */
export const computerChunk = defineChunk("computer", () => import("./threads/computer"));

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
  searchChunk,
  inboxChunk,
  notesChunk,
  selectChunk,
  accountsChunk,
  workspaceThreadsChunk,
  menuChunk,
  customizeChunk,
  dialogsChunk,
  pickersChunk,
  commandMenuChunk,
  macBridgeChunk,
  awayReturnChunk,
  virtualChunk,
  messageListChunk,
  reviewChunk,
  computerChunk,
};
