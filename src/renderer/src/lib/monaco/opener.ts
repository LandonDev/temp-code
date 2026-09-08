import type { OpenFileFn } from "../search";

/**
 * The editor chunk's way back into the app shell: cross-file navigation
 * (go to definition, usages, the debugger's top frame) opens files through
 * whatever pane last mounted. Every pane hands over the same App callback.
 */

let opener: OpenFileFn | null = null;

export function setFileOpener(fn: OpenFileFn | null): void {
  opener = fn;
}

export function openFileAt(path: string, line?: number, column?: number): boolean {
  if (!opener) return false;
  opener(path, line ? { line, column } : undefined);
  return true;
}
