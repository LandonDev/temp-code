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
