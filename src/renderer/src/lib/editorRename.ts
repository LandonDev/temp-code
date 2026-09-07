/**
 * File-rename intelligence seam: the editor chunk registers a
 * workspace/willRenameFiles handler when loaded, and the file tree calls
 * through here before the actual rename so imports get updated. A no-op
 * until the chunk (and the IntelliJ engine) is up.
 */

type WillRename = (cwd: string, fromPath: string, toPath: string) => Promise<void>;
let handler: WillRename | null = null;

export function registerWillRename(fn: WillRename): void {
  handler = fn;
}

export async function applyWillRename(cwd: string, fromPath: string, toPath: string): Promise<void> {
  await handler?.(cwd, fromPath, toPath).catch(() => undefined);
}

/**
 * Before a rename or move lands on disk the editor chunk settles the open
 * buffers under the path (flush with autosave on, carry the dirty text to
 * the new path with it off) so the tab that re-opens shows the right text.
 */
type BeforeMove = (fromPath: string, toPath: string) => Promise<void>;
let beforeMove: BeforeMove | null = null;

export function registerBeforeMove(fn: BeforeMove): void {
  beforeMove = fn;
}

export async function applyBeforeMove(fromPath: string, toPath: string): Promise<void> {
  await beforeMove?.(fromPath, toPath).catch(() => undefined);
}
