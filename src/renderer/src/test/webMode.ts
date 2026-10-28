/**
 * Run a dom test as the /ui page: the dom suite is the desktop window, with
 * `window.api` set by domSetup.ts; web mode is a page without it. Returns
 * the restore, for an afterEach.
 */
export function asWebPage(): () => void {
  const api = (window as { api?: unknown }).api;
  delete (window as { api?: unknown }).api;
  return () => {
    (window as { api?: unknown }).api = api;
  };
}
