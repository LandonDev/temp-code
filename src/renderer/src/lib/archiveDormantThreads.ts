/** "Archive dormant threads" once a project card's or the workspace's menu
 *  row is picked: `roots` and each master's settled batch with them,
 *  sparing the tree on screen. The work is lib/archiveDormant.ts, loaded
 *  only now, so none of it rides the first paint. */
export function archiveDormantThreads(roots: readonly { id: string }[], activeSessionId: string | null | undefined): void {
  void import("./archiveDormant").then((m) => m.archiveDormant(roots, activeSessionId));
}
