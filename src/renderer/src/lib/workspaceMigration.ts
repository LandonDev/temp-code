import {
  loadArchivedProjects,
  loadRecents,
  looksLikeProject,
  normalizeProjectPath,
  type ArchivedProject,
  type RecentProject,
} from "./recents";
import { createWorkspace } from "./tcserver/projects";

const FLAG = "monocode.tc.workspacesMigrated";

/** Folders the rail knew before workspaces existed, each once, recents first. */
export function planWorkspaceMigration(
  recents: RecentProject[],
  archived: ArchivedProject[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of [...recents, ...archived]) {
    const path = normalizeProjectPath(item.path);
    if (seen.has(path) || !looksLikeProject(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

let running: Promise<void> | null = null;

/** One-time: every remembered folder becomes a workspace. Folders the
 *  server refuses are skipped; archived ones stay hidden by the local list. */
export function migrateWorkspaces(
  create: (path: string) => Promise<unknown> = createWorkspace,
): Promise<void> {
  if (running) return running;
  if (localStorage.getItem(FLAG)) return Promise.resolve();
  running = (async () => {
    for (const path of planWorkspaceMigration(loadRecents(), loadArchivedProjects())) {
      try {
        await create(path);
      } catch {
        // missing on disk or otherwise rejected — nothing to carry over
      }
    }
    localStorage.setItem(FLAG, "1");
  })().finally(() => {
    running = null;
  });
  return running;
}
