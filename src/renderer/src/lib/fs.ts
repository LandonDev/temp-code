import type { FsFileDigest, FsMedia, GitFileMedia } from "@server/shared/contract-fsgit";
import { invoke, invokeOn, open } from "./native";

export type FsEntry = {
  name: string;
  path: string;
  isDir: boolean;
  ignored: boolean;
};

export type ProjectFile = {
  name: string;
  path: string;
  relative: string;
  isDir?: boolean;
};

export function listDir(environmentId: string, path: string): Promise<FsEntry[]> {
  return invokeOn<FsEntry[]>(environmentId, "list_dir", { path });
}

export function listProjectFiles(environmentId: string, cwd: string): Promise<ProjectFile[]> {
  return invokeOn<ProjectFile[]>(environmentId, "list_project_files", { cwd });
}

export type GitDiffStats = {
  files: number;
  additions: number;
  deletions: number;
};

export function gitDiffStats(environmentId: string, cwd: string): Promise<GitDiffStats> {
  return invokeOn<GitDiffStats>(environmentId, "git_diff_stats", { cwd });
}

export type GitChangedFile = {
  path: string;
  relative: string;
  status: "modified" | "added" | "deleted" | "untracked" | string;
  additions: number;
  deletions: number;
  staged: boolean;
  unstaged: boolean;
};

export type GitDiffIndex = {
  branch: string | null;
  files: GitChangedFile[];
  additions: number;
  deletions: number;
  remote: string | null;
  upstream: string | null;
  defaultBranch: string | null;
  ahead: number;
  behind: number;
  aheadOfDefault: number;
};

export function gitDiffIndex(environmentId: string, cwd: string): Promise<GitDiffIndex> {
  return invokeOn<GitDiffIndex>(environmentId, "git_diff_index", { cwd });
}

export type GitFileDiff = {
  path: string;
  relative: string;
  status: string;
  original: string;
  current: string;
  binary: boolean;
  tooLarge: boolean;
};

/** `base` picks the left side: the index (default) or HEAD. */
export function gitFileDiff(environmentId: string, cwd: string,
  relative: string,
  base?: "index" | "HEAD",
): Promise<GitFileDiff> {
  return invokeOn<GitFileDiff>(environmentId, "git_file_diff", { cwd, relative, base });
}

export type GitLogEntry = {
  hash: string;
  short: string;
  subject: string;
  author: string;
  /** ISO 8601 author date */
  date: string;
};

export function gitLog(environmentId: string, cwd: string, limit = 20): Promise<GitLogEntry[]> {
  return invokeOn<GitLogEntry[]>(environmentId, "git_log", { cwd, limit });
}

export function gitStageContents(environmentId: string, cwd: string,
  relative: string,
  contents: string,
): Promise<void> {
  return invokeOn<void>(environmentId, "git_stage_contents", { cwd, relative, contents });
}

export function gitStageFile(environmentId: string, cwd: string, relative: string): Promise<void> {
  return invokeOn<void>(environmentId, "git_stage_file", { cwd, relative });
}

export function gitUnstageFile(environmentId: string, cwd: string, relative: string): Promise<void> {
  return invokeOn<void>(environmentId, "git_unstage_file", { cwd, relative });
}

export function gitDiscardFile(environmentId: string, cwd: string, relative: string): Promise<void> {
  return invokeOn<void>(environmentId, "git_discard_file", { cwd, relative });
}

export function gitStageAll(environmentId: string, cwd: string): Promise<void> {
  return invokeOn<void>(environmentId, "git_stage_all", { cwd });
}

export function gitUnstageAll(environmentId: string, cwd: string): Promise<void> {
  return invokeOn<void>(environmentId, "git_unstage_all", { cwd });
}

export function gitCommit(environmentId: string, cwd: string, message: string): Promise<void> {
  return invokeOn<void>(environmentId, "git_commit", { cwd, message });
}

export type GitStagedContext = {
  branch: string | null;
  summary: string;
  patch: string;
};

export function gitStagedContext(environmentId: string, cwd: string): Promise<GitStagedContext> {
  return invokeOn<GitStagedContext>(environmentId, "git_staged_context", { cwd });
}

export function gitPush(environmentId: string, cwd: string): Promise<void> {
  return invokeOn<void>(environmentId, "git_push", { cwd });
}

export function gitPull(environmentId: string, cwd: string): Promise<void> {
  return invokeOn<void>(environmentId, "git_pull", { cwd });
}

export function gitSync(environmentId: string, cwd: string): Promise<void> {
  return invokeOn<void>(environmentId, "git_sync", { cwd });
}

export type GitRangeContext = {
  base: string;
  head: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
};

export function gitRangeContext(environmentId: string, cwd: string): Promise<GitRangeContext> {
  return invokeOn<GitRangeContext>(environmentId, "git_range_context", { cwd });
}

export type GitPr = {
  number: number;
  title: string;
  url: string;
  state: string;
};

export function gitPrStatus(environmentId: string, cwd: string): Promise<GitPr | null> {
  return invokeOn<GitPr | null>(environmentId, "git_pr_status", { cwd });
}

export function gitPrCreate(environmentId: string, cwd: string,
  title: string,
  body: string,
  base: string,
  head: string,
): Promise<string> {
  return invokeOn<string>(environmentId, "git_pr_create", { cwd, title, body, base, head });
}

export type GitBranchInfo = {
  name: string;
  current: boolean;
  remote: string | null;
};

export type GitBranches = {
  current: string | null;
  detached: boolean;
  branches: GitBranchInfo[];
};

export function gitBranches(environmentId: string, cwd: string): Promise<GitBranches> {
  return invokeOn<GitBranches>(environmentId, "git_branches", { cwd });
}

export function gitCheckout(environmentId: string, cwd: string,
  name: string,
  remote?: string | null,
): Promise<string> {
  return invokeOn<string>(environmentId, "git_checkout", { cwd, name, remote: remote ?? null });
}

export function gitCreateBranch(environmentId: string, cwd: string, name: string): Promise<string> {
  return invokeOn<string>(environmentId, "git_create_branch", { cwd, name });
}

export function gitStash(environmentId: string, cwd: string, message?: string): Promise<void> {
  return invokeOn<void>(environmentId, "git_stash", { cwd, message: message ?? null });
}

/** Git refused a checkout because the working tree would be overwritten. */
export function isCheckoutBlockedByChanges(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes("would be overwritten") ||
    text.includes("commit your changes or stash") ||
    text.includes("please move or remove them before")
  );
}

/** Drop leftover session-worktree pins. The composer now switches this folder. */
export function restoreSessionCheckout<
  T extends { cwd: string; branch?: string; worktreeCwd?: string; providerSessionId?: string },
>(session: T): T {
  if (!session.branch && !session.worktreeCwd) return session;
  return {
    ...session,
    branch: undefined,
    worktreeCwd: undefined,
    ...(session.worktreeCwd ? { providerSessionId: undefined } : {}),
  };
}

export { notifyGitChanged, subscribeGitChanged } from "./gitChanged";

export function createPath(environmentId: string, parent: string,
  name: string,
  isDir: boolean,
): Promise<string> {
  return invokeOn<string>(environmentId, "create_path", { parent, name, isDir });
}

export function renamePath(environmentId: string, path: string, name: string): Promise<string> {
  return invokeOn<string>(environmentId, "rename_path", { path, name });
}

export function deletePath(environmentId: string, path: string): Promise<void> {
  return invokeOn<void>(environmentId, "delete_path", { path });
}

export function copyPath(environmentId: string, from: string, destParent: string): Promise<string> {
  return invokeOn<string>(environmentId, "copy_path", { from, destParent });
}

export function movePath(environmentId: string, from: string, destParent: string): Promise<string> {
  return invokeOn<string>(environmentId, "move_path", { from, destParent });
}

/** Finder on this machine; a remote path has nothing to reveal here. */
/** sha256 per path on one host; null for a path that is missing or not a file. */
export function digestFiles(environmentId: string, paths: string[]): Promise<FsFileDigest[]> {
  return invokeOn<FsFileDigest[]>(environmentId, "file_digest", { paths });
}

export function revealPath(path: string): Promise<void> {
  return invoke<void>("reveal_path", { path });
}

/** This machine's home directory (preload), used for the folder picker. */
export function homeDir(): Promise<string> {
  return invoke<string>("home_dir");
}

/**
 * Where Open project browses: another host's folders over its link (the
 * environment id), or null for this machine's native picker. The page at
 * /ui has no native picker, so there its own host is browsed too.
 */
export function folderPickOn(environmentId: string | undefined, primaryId: string, web: boolean): string | null {
  if (environmentId && environmentId !== primaryId) return environmentId;
  return web ? primaryId : null;
}

export async function pickFolder(title = "Open project"): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title,
  });
  return typeof selected === "string" && selected ? selected : null;
}

export async function pickFiles(title = "Attach files"): Promise<string[] | null> {
  const selected = await open({
    multiple: true,
    directory: false,
    title,
  });
  if (Array.isArray(selected)) {
    const paths = selected.filter((path): path is string => Boolean(path));
    return paths.length > 0 ? paths : null;
  }
  if (typeof selected === "string" && selected) return [selected];
  return null;
}

export function cloneRepo(environmentId: string, url: string, parent: string): Promise<string> {
  return invokeOn<string>(environmentId, "clone_repo", { url, parent });
}

export function readFilePreview(environmentId: string, path: string,
  maxLines = 6,
  startLine?: number,
): Promise<string[]> {
  return invokeOn<string[]>(environmentId, "read_file_preview", {
    path,
    maxLines,
    startLine,
  });
}

export type FileMtime = {
  path: string;
  mtimeMs: number | null;
};

export function statFiles(environmentId: string, paths: string[]): Promise<FileMtime[]> {
  if (paths.length === 0) return Promise.resolve([]);
  return invokeOn<FileMtime[]>(environmentId, "stat_files", { paths });
}

export function readTextFile(environmentId: string, path: string): Promise<string> {
  return invokeOn<string>(environmentId, "read_text_file", { path });
}

export type FileMedia = FsMedia;

/** What the viewer shows for an image, video or audio file; null for anything else. */
export function fileMedia(environmentId: string, path: string): Promise<FileMedia | null> {
  return invokeOn<FileMedia | null>(environmentId, "file_media", { path });
}

/** Both sides of a changed media file for the review view; `base` is the index or a ref. */
export function gitFileMedia(environmentId: string, cwd: string,
  relative: string,
  base?: string,
): Promise<GitFileMedia> {
  return invokeOn<GitFileMedia>(environmentId, "git_file_media", { cwd, relative, base });
}

export function writeTextFile(environmentId: string, path: string, content: string): Promise<void> {
  return invokeOn<void>(environmentId, "write_text_file", { path, content });
}

/** Last path segment, or `/` for the filesystem root. */
export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "") || "/";
  const parts = trimmed.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? trimmed;
}
