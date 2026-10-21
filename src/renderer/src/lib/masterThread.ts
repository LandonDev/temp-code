import type { ProjectMeta } from "./tcserver/types";

/** Is this session its project's master thread (CLAUDE.md "Master threads")?
 *  The pin lives on the project row; a session with no project is never one. */
export function isMasterThread(
  session: { id: string; projectId?: string | null },
  projects: readonly Pick<ProjectMeta, "id" | "masterThreadId">[],
): boolean {
  if (!session.projectId) return false;
  const project = projects.find((p) => p.id === session.projectId);
  return !!project?.masterThreadId && project.masterThreadId === session.id;
}
