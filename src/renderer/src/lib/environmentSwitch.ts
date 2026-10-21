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

type Candidate = { path: string; name: string; githubRepo?: string | null; createdAt: number };

/** The workspace a switch lands on: the one that is the same project as
 *  `from` (same GitHub repo, else the same folder name), else the one the
 *  window was last on there, else the oldest; undefined for an empty pool. */
export function workspaceToLandOn<W extends Candidate>(
  pool: readonly W[],
  from: Candidate | undefined,
  remembered: string | undefined,
  samePath: (a: string, b: string) => boolean,
): W | undefined {
  const same =
    (from?.githubRepo && pool.find((w) => w.githubRepo === from.githubRepo)) ||
    (from && pool.find((w) => w.name === from.name));
  return (
    same ||
    (remembered ? pool.find((w) => samePath(w.path, remembered)) : undefined) ||
    [...pool].sort((a, b) => a.createdAt - b.createdAt)[0]
  );
}
