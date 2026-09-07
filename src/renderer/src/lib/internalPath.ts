/**
 * Which paths belong to the app rather than to the user. Writes under a
 * project's `.temp-code/` are bookkeeping (memory, plans, thread notes) and
 * read as "Updated project memory", not as file edits; the one exception is
 * `~/.temp-code/worktrees/…`, where whole checkouts live and every file is
 * the user's own.
 */
export const isInternalPath = (p: string): boolean =>
  /(^|\/)\.temp-code(\/(?!worktrees\/)|$)/.test(p);

/** A capture's own files — the nanoid name means nothing to anyone. */
export const isAppshotPath = (p: string): boolean => /-appshot\.(png|jpg|md)$/.test(p);

/** What a set of internal paths amounts to, in the words a row uses. */
export function memoryLabel(paths: string[]): string {
  if (paths.some((p) => p.endsWith("PROJECT.md"))) return "project memory";
  if (paths.some((p) => /plan-[\w-]+\.md$/.test(p))) return "the plan";
  if (paths.some((p) => p.includes(".temp-code/threads/"))) return "thread notes";
  return "app files";
}
