/**
 * The dialogs an action opens (a menu row, a button, a fleet switch), one
 * barrel behind `dialogsChunk` (surfaces/chunks.ts): each mounts through
 * `dialogsChunk.surface` only while it is open, so none of their bodies (or
 * the sheet, select and scroll-area they use) is in the first paint.
 * ConfirmDialog and Modal stay there: dialog.tsx is the one primitive the
 * first paint keeps.
 */
export { ThreadBatchDialog } from "./ThreadBatchDialog";
export { WhatsNewDialog } from "./WhatsNewDialog";
export { NewProjectDialog, NewWorkspaceDialog, ProjectSettingsDialog, ProjectTeardownDialog } from "./ProjectDialogs";
export { RemoteFolderDialog } from "./RemoteFolderDialog";
export { ThreadDefaultsDialog } from "./ThreadDefaultsDialog";
export { PreambleDialog } from "./PreambleDialog";
