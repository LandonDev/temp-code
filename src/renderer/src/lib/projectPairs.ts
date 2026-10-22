import type { WorkspaceMeta } from "./tcserver/types";

/**
 * The same project on two hosts: the Mac's checkout and the box's clone of
 * one repository. Search runs a query on every host and needs to know
 * which copies are the same project, so a file at the same relative path
 * in both folds into one row and both hosts' hits carry one project name.
 *
 * Two workspaces pair when they carry one link id (shared/projectLinks.ts:
 * the linker stamps copies of one workspace with a `wl_…` id); rows the
 * linker has not reached yet pair when they name the same GitHub
 * repository, else when their folders share a name, the rule the linker
 * itself applies. Within one host the first workspace with a key keeps
 * it, so a pair has at most one member per host; a workspace with no
 * partner is a pair of one, so every path has a pair to be relative to.
 */

export type PairMember = {
  environmentId: string;
  /** The workspace folder on that host. */
  cwd: string;
  name: string;
};

export type ProjectPair = {
  id: string;
  /** The name both hosts' hits show. */
  name: string;
  members: PairMember[];
};

const strip = (path: string): string => path.replace(/\/+$/, "") || "/";
const basename = (path: string): string => strip(path).split("/").pop() ?? path;

export function pairKey(workspace: Pick<WorkspaceMeta, "path" | "githubRepo" | "linkId">): string {
  const link = workspace.linkId?.trim();
  if (link) return `link:${link}`;
  const repo = workspace.githubRepo?.trim().toLowerCase();
  return repo ? `repo:${repo}` : `name:${basename(workspace.path).toLowerCase()}`;
}

export function pairWorkspaces(workspaces: readonly WorkspaceMeta[]): ProjectPair[] {
  const pairs = new Map<string, ProjectPair>();
  for (const workspace of workspaces) {
    const key = pairKey(workspace);
    const pair = pairs.get(key) ?? { id: key, name: workspace.name, members: [] };
    if (pair.members.some((m) => m.environmentId === workspace.environmentId)) continue;
    pair.members.push({ environmentId: workspace.environmentId, cwd: strip(workspace.path), name: workspace.name });
    pairs.set(key, pair);
  }
  return [...pairs.values()];
}

/** The pair whose member on `environmentId` holds `path`; the deepest
 *  member folder wins when one workspace sits inside another. */
export function pairOf(
  pairs: readonly ProjectPair[],
  environmentId: string,
  path: string,
): { pair: ProjectPair; member: PairMember } | undefined {
  const target = strip(path);
  let best: { pair: ProjectPair; member: PairMember } | undefined;
  for (const pair of pairs) {
    for (const member of pair.members) {
      if (member.environmentId !== environmentId) continue;
      if (target !== member.cwd && !target.startsWith(`${member.cwd}/`)) continue;
      if (!best || member.cwd.length > best.member.cwd.length) best = { pair, member };
    }
  }
  return best;
}

/** `path` relative to its pair member's folder, or undefined when no pair holds it. */
export function relativeInPair(
  pairs: readonly ProjectPair[],
  environmentId: string,
  path: string,
): { pair: ProjectPair; relative: string } | undefined {
  const found = pairOf(pairs, environmentId, path);
  if (!found) return undefined;
  const target = strip(path);
  const relative = target === found.member.cwd ? "" : target.slice(found.member.cwd.length + 1);
  return { pair: found.pair, relative };
}

/** The other hosts' copies of the project that holds `path` on `environmentId`. */
export function partnersOf(pairs: readonly ProjectPair[], environmentId: string, path: string): PairMember[] {
  const found = pairOf(pairs, environmentId, path);
  if (!found) return [];
  return found.pair.members.filter((m) => m.environmentId !== environmentId);
}
