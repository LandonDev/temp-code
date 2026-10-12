import type { GitDiffStats } from "../lib/fs";
import { useGitDiffStats } from "../lib/gitIndexStore";

/** +/− and file count for a checkout's badges, from the shared git index. */
export function useProjectDiffStats(
  cwd: string,
  enabled: boolean,
): GitDiffStats | null {
  return useGitDiffStats(cwd, enabled);
}
