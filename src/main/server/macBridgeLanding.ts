import { join } from 'node:path'
import type { SessionMeta } from '@shared/events'

/**
 * Where a file fetched from the Mac lands on the box (mac.fetchFile):
 * `<project cwd>/.temp-code/attachments/<sessionId>/`, else the thread's
 * workspace path, else `<userData>/attachments/<sessionId>/` (which index.ts
 * adds to managedRoots so the thread's own remote viewers may read it).
 * `.temp-code/` is gitignored and hidden from the file tree (files.ts).
 *
 * TODO(merge): the attachment-upload branch adds attachmentDir(session) in
 * src/main/server/attachmentDir.ts with this same rule; fold this file into
 * it on merge and call attachmentDir from macTools.ts.
 */
export interface LandingLookup {
  getProject(id: string): { cwd: string } | null | undefined
  getWorkspace(id: string): { path: string } | null | undefined
}

export function macBridgeLandingDir(
  session: Pick<SessionMeta, 'id' | 'projectId' | 'workspaceId'>,
  lookup: LandingLookup,
  dataDir: string
): string {
  const project = session.projectId ? lookup.getProject(session.projectId) : null
  if (project?.cwd) return join(project.cwd, '.temp-code', 'attachments', session.id)
  const workspace = session.workspaceId ? lookup.getWorkspace(session.workspaceId) : null
  if (workspace?.path) return join(workspace.path, '.temp-code', 'attachments', session.id)
  return join(dataDir, 'attachments', session.id)
}

/** The fallback root, for managedRoots. */
export const macBridgeLandingRoot = (dataDir: string): string => join(dataDir, 'attachments')
