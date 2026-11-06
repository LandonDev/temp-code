/**
 * Which paths belong to the app rather than to the user. The app's own
 * bookkeeping under a `.temp-code/` dir (memory, plans, reports, thread
 * notes, attachments, tool caches) reads as "Updated project memory" and the
 * like, not as file edits. Only the files and folders the app writes count:
 * everything else under `.temp-code/` (`worktrees/`, a thread's own clone,
 * anything new) is the user's own code and renders as an edit.
 */
const APP_FILES = String.raw`PROJECT\.md|PROJECT-archive\.md|plan-[^/]+\.md|moved-changes\.patch`;
const APP_DIRS = "attachments|plans|reports|refs|threads|builds|dev-server|intellij-server|jdtls";
const INTERNAL = new RegExp(String.raw`(^|/)\.temp-code(/(?:(?:${APP_FILES})$|(?:${APP_DIRS})(?:/|$))|/?$)`);

export const isInternalPath = (p: string): boolean => INTERNAL.test(p);

/** A capture's own files — the nanoid name means nothing to anyone. */
export const isAppshotPath = (p: string): boolean => /-appshot\.(png|jpg|md)$/.test(p);

/** What a set of internal paths amounts to, in the words a row uses. */
export function memoryLabel(paths: string[]): string {
  if (paths.some((p) => p.endsWith("PROJECT.md"))) return "project memory";
  if (paths.some((p) => /plan-[\w-]+\.md$/.test(p))) return "the plan";
  // A research root's report sits in reports/; an explorer's findings
  // file one directory down, under the root's id.
  if (paths.some((p) => /\.temp-code\/reports\/[^/]+\/[^/]+$/.test(p))) return "findings";
  if (paths.some((p) => /\.temp-code\/reports\/[^/]+$/.test(p))) return "the report";
  if (paths.some((p) => p.includes(".temp-code/threads/"))) return "thread notes";
  return "app files";
}
