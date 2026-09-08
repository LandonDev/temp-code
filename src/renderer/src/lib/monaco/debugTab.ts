/**
 * Window events from the editor chunk to the app shell. The debugger now
 * lives in the rail's Debug tab (`lib/railPanel.ts`); OPEN_DEBUG_EVENT is
 * no longer fired and stays only because App.tsx still listens for it —
 * M8e can drop the listener and this constant together.
 */
export const OPEN_DEBUG_EVENT = "monocode:open-debug";
export const OPEN_SETTINGS_EVENT = "monocode:open-settings";

export function requestSettings(section: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: section }));
}
