/**
 * The switcher and the rail ask the window to move to another environment;
 * App answers (it owns tabs and the workspace). Same shape as
 * projectRailActions: a request, and one subscriber.
 */
const listeners = new Set<(id: string) => void>();

export function requestEnvironmentSwitch(id: string): void {
  for (const l of listeners) l(id);
}

export function subscribeEnvironmentSwitch(listener: (id: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
