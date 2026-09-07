import { joinPath } from "./paths";

/**
 * A file reference as the transcript renders it — maybe relative, maybe
 * with a `:line(:col)` tail — resolved to the path the menu acts on.
 * `abs` is null when there is nothing on disk to reveal: a `~` path or a
 * relative one with no project cwd to hang it on.
 */
export type FileRefTarget = { clean: string; abs: string | null; name: string };

export function fileRefTarget(target: string, cwd?: string): FileRefTarget {
  const clean = target.trim().replace(/:\d+(?::\d+)?$/, "");
  const abs = clean.startsWith("/")
    ? clean
    : clean.startsWith("~") || !cwd
      ? null
      : joinPath(cwd, clean);
  return { clean, abs, name: clean.split("/").pop() || clean };
}
