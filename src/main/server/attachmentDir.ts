import { join } from 'node:path'
import type { SessionMeta } from '@shared/events'

/**
 * Where a thread's attachments land on the host that runs it (docs/box.md
 * "Attachments on a remote thread"). One directory per thread:
 *
 *   1. `<project cwd>/.temp-code/attachments/<sessionId>/` — the project's
 *      `.temp-code/` is already git-excluded (threads.ts, git.ts
 *      ensureLocalExclude) and sits under a managed root the fence admits;
 *   2. else `<workspace path>/.temp-code/attachments/<sessionId>/` for a
 *      projectless chat hanging off a workspace;
 *   3. else `<userData>/attachments/<sessionId>/` (a draft the server has not
 *      seen yet, a floating chat), a root `managedRoots()` lists.
 *
 * The upload store (attachmentUploads.ts) and the Mac bridge's
 * `mac.fetchFile` both land files here. The server sets the context once at
 * boot; until then (unit tests) only the explicit-context form works.
 */

export type AttachmentSession = Pick<SessionMeta, 'id' | 'projectId' | 'workspaceId'>

export interface AttachmentDirContext {
  /** The session row, or null when the server has not seen it (a draft). */
  session(id: string): AttachmentSession | null
  projectCwd(projectId: string): string | null | undefined
  workspacePath(workspaceId: string): string | null | undefined
  /** `<userData>`: the fallback root lives at `<userData>/attachments`. */
  dataDir: string
}

let current: AttachmentDirContext | null = null

export function setAttachmentDirContext(ctx: AttachmentDirContext | null): void {
  current = ctx
}

/** Session ids are `[A-Za-z0-9_-]+` (CreateSessionParams); anything else never names a directory. */
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

export function assertSessionId(id: string): void {
  if (!SESSION_ID_RE.test(id)) throw new Error('bad session id')
}

/** `<base>/.temp-code/attachments`: the per-tree root that holds every thread's dir. */
export const treeAttachmentsRoot = (base: string): string => join(base, '.temp-code', 'attachments')

/** `<userData>/attachments`: the fallback root. Null before the server set the context. */
export function dataAttachmentsRoot(ctx: AttachmentDirContext | null = current): string | null {
  return ctx ? join(ctx.dataDir, 'attachments') : null
}

function needContext(ctx: AttachmentDirContext | null): AttachmentDirContext {
  if (!ctx) throw new Error('attachment directories are not configured')
  return ctx
}

function resolveSession(session: AttachmentSession | string, ctx: AttachmentDirContext): AttachmentSession {
  if (typeof session !== 'string') return session
  return ctx.session(session) ?? { id: session, projectId: null, workspaceId: null }
}

/** The directory a thread's attachments land in (not created here). */
export function attachmentDir(session: AttachmentSession | string, ctx: AttachmentDirContext | null = current): string {
  const c = needContext(ctx)
  const s = resolveSession(session, c)
  assertSessionId(s.id)
  const project = s.projectId ? c.projectCwd(s.projectId) : null
  if (project) return join(treeAttachmentsRoot(project), s.id)
  const workspace = s.workspaceId ? c.workspacePath(s.workspaceId) : null
  if (workspace) return join(treeAttachmentsRoot(workspace), s.id)
  return join(dataAttachmentsRoot(c)!, s.id)
}

/** Every directory a thread's attachments may sit in: where they land now,
 *  and the userData fallback a draft's uploads took before the server knew
 *  its project. What the delete and archive sweeps remove. */
export function attachmentDirsOf(session: AttachmentSession | string, ctx: AttachmentDirContext | null = current): string[] {
  const c = needContext(ctx)
  const s = resolveSession(session, c)
  if (!SESSION_ID_RE.test(s.id)) return []
  return [...new Set([attachmentDir(s, c), join(dataAttachmentsRoot(c)!, s.id)])]
}
