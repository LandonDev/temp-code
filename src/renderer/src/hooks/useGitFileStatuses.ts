import { useMemo } from "react";
import type { GitDiffIndex } from "../lib/fs";
import { useGitIndex } from "../lib/gitIndexStore";
import { parentPath } from "../lib/paths";

export type GitStatusMap = {
  files: Map<string, string>;
  dirs: Map<string, string>;
};

const STATUS_PRIORITY: Record<string, number> = {
  modified: 3,
  deleted: 2,
  added: 1,
  untracked: 1,
};

const EMPTY: GitStatusMap = { files: new Map(), dirs: new Map() };

export function buildStatusMaps(index: GitDiffIndex, cwd: string): GitStatusMap {
  const files = new Map<string, string>();
  const dirs = new Map<string, string>();
  for (const file of index.files) {
    files.set(file.path, file.status);
    const prio = STATUS_PRIORITY[file.status] ?? 0;
    if (prio === 0) continue;
    let dir = parentPath(file.path);
    while (dir.length > cwd.length) {
      const existing = dirs.get(dir);
      const existingPrio = existing ? (STATUS_PRIORITY[existing] ?? 0) : 0;
      if (prio > existingPrio) {
        dirs.set(dir, file.status);
      } else {
        break;
      }
      dir = parentPath(dir);
    }
  }
  return { files, dirs };
}

/** Per-file and per-directory git status for the file tree, from the shared git index. */
export function useGitFileStatuses(
  cwd: string,
  enabled: boolean,
): GitStatusMap {
  const index = useGitIndex(cwd, enabled);
  return useMemo(() => (index ? buildStatusMaps(index, cwd) : EMPTY), [index, cwd]);
}
