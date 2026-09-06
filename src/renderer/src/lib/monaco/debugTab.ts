/** Ask the app shell to dock the debug pane for a file (fired by ⌃D). */
export const OPEN_DEBUG_EVENT = "monocode:open-debug";
export const OPEN_SETTINGS_EVENT = "monocode:open-settings";

export function requestDebugTab(cwd: string, path: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_DEBUG_EVENT, { detail: { cwd, path } }));
}

export function requestSettings(section: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: section }));
}
