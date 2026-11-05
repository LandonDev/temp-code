import { archive } from "./tcserver/commands";
import { sessionStore } from "./tcserver/store";
import type { SessionMeta } from "./tcserver/types";
import { batchHome, dormantThreads, focusedTree, railMasters } from "./threadStripModel";

/**
 * "Archive dormant threads" once a project card's or the workspace's menu
 * row is picked (lib/archiveDormantThreads.ts reaches it through
 * `import()`, so none of it rides the first paint). The menu counts
 * the dormant roots (`dormantThreads` over roots that are not housed in a
 * batch); archiving them takes, with each master among them, its batch's
 * settled threads (`settledBatchOf`), first, sparing the tree on screen.
 */
export function archiveDormant(roots: readonly { id: string }[], activeSessionId: string | null | undefined): void {
  const metas = sessionStore.metas();
  const all = [...settledBatchOf(metas, roots, focusedTree(metas, activeSessionId)), ...roots];
  void Promise.allSettled(all.map((t) => archive(t.id, true)));
}

/** The settled threads of the batches of the masters among `roots`. A
 *  batch lives inside its master as subagents live inside a root, so it
 *  goes with it instead of standing as plain roots once the master is
 *  gone. A batch thread is never unread (the person reads the master): its
 *  state, pin, held plan and `exclude` (the focused tree) are what keep
 *  it; one that works, waits or failed stays, an ordinary root from then on. */
export function settledBatchOf(
  metas: readonly SessionMeta[],
  roots: readonly { id: string }[],
  exclude: ReadonlySet<string>,
): SessionMeta[] {
  const masters = railMasters(metas);
  const picked = new Set(roots.map((r) => r.id));
  const batch = metas.filter((m) => {
    const home = batchHome(m, masters);
    return home !== null && picked.has(home);
  });
  return dormantThreads(batch, {}, Number.POSITIVE_INFINITY, exclude);
}
