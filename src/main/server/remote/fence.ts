import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { ClientRequest } from '@shared/contract'

/**
 * The path fence for remote principals (R2 H1/H2). The donor `fs.*`,
 * `git.*`, `github.*` and `search.project` methods take any path or cwd;
 * the desktop's own socket may use them anywhere, a key over the tunnel
 * may not. Every path a remote request names must sit, by its REAL
 * spelling, under one of the app-managed roots the server lists: project
 * working trees (worktrees included), workspace paths (the `.temp-code`
 * dirs and plan files live there) and the configured or box work root —
 * never the bare home-directory fallback. A symlink inside a root that
 * points out is refused, the media fence's rule rather than the
 * either-spelling one of fspaths.withinRoots.
 */

/** The one error a remote caller sees: typed, constant, and never carrying the path. */
export class FenceError extends Error {
  readonly code = 'outside-roots' as const
  constructor(method: string) {
    super(`forbidden: ${method} is outside app-managed roots`)
    this.name = 'FenceError'
  }
}

/** `~` the way fspaths and gitops read it, then absolute. */
export function expandPath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith(`~${sep}`)) return join(homedir(), path.slice(2))
  return resolve(path)
}

/** The real spelling of a path whose tail may not exist yet: the deepest
 *  existing ancestor is resolved and the missing tail put back. */
export function realSpelling(path: string): string {
  const tail: string[] = []
  let head = path
  for (;;) {
    try {
      return join(realpathSync(head), ...tail.reverse())
    } catch {
      const parent = dirname(head)
      if (parent === head) return path
      tail.push(basename(head))
      head = parent
    }
  }
}

/** Strict containment on a segment boundary, real path against real root. */
export function insideRoots(path: string, roots: readonly string[]): boolean {
  const real = realSpelling(expandPath(path))
  return roots.some((root) => {
    const r = realSpelling(resolve(root))
    return real === r || real.startsWith(r + sep)
  })
}

type Params<M extends ClientRequest['method']> = Extract<ClientRequest, { method: M; params: unknown }>['params']
type Picker<M extends ClientRequest['method']> = (params: Params<M>) => string[]

/** The pickers shared by every `cwd` method and every one-`path` method. */
const cwd = (p: { cwd: string }): string[] => [p.cwd]
const path = (p: { path: string }): string[] => [p.path]

/**
 * Which params of a request name a path or working directory. Project-
 * scoped methods (`fs.list`, `fs.read`, `fs.write`, … by projectId) and
 * `fs.media` (its own realpath fence) are not here; the test asserts the
 * table covers every other path-taking method in the contract.
 */
export const FENCED_PARAMS: { [M in ClientRequest['method']]?: Picker<M> } = {
  'fs.deletePath': path,
  'fs.listPath': path,
  'fs.readBase64': path,
  'fs.readPreview': path,
  'fs.readText': path,
  'fs.writeText': path,
  // A new name must land inside the root too.
  'fs.createPath': (p) => [p.parent, join(expandPath(p.parent), p.name)],
  'fs.renamePath': (p) => [p.path, join(dirname(expandPath(p.path)), p.name)],
  'fs.copyPath': (p) => [p.from, p.destParent],
  'fs.movePath': (p) => [p.from, p.destParent],
  'fs.statFiles': (p) => p.paths,
  'fs.digest': (p) => p.paths,
  'fs.inspectPaths': (p) => p.paths,
  'fs.projectFiles': cwd,
  'git.branches': cwd,
  'git.checkout': cwd,
  'git.clone': (p) => [p.parent],
  'git.commitStaged': cwd,
  'git.createBranch': cwd,
  'git.diffIndex': cwd,
  'git.diffStats': cwd,
  'git.discardFile': cwd,
  'git.fileDiff': cwd,
  'git.fileMedia': cwd,
  'git.log': cwd,
  'git.pull': cwd,
  'git.push': cwd,
  'git.rangeContext': cwd,
  'git.stageAll': cwd,
  'git.stageContents': cwd,
  'git.stageFile': cwd,
  'git.stagedContext': cwd,
  'git.stash': cwd,
  'git.sync': cwd,
  'git.unstageAll': cwd,
  'git.unstageFile': cwd,
  'github.comment': cwd,
  'github.createPr': cwd,
  'github.details': cwd,
  'github.prDiff': cwd,
  'github.prStatus': cwd,
  'github.thread': cwd,
  'search.project': (p) => [p.options.cwd],
  // These widen the roots, read files by path, or run something in a cwd:
  // a remote key may only do so inside them.
  'workspace.create': (p) => [p.path],
  'projectLogo.save': (p) => [p.projectPath, p.sourcePath],
  'projectLogo.remove': (p) => [p.projectPath],
  'build.detect': (p) => [p.path],
  'commands.list': (p) => [p.cwd],
  'text.generate': (p) => (p.cwd ? [p.cwd] : []),
  'session.create': (p) => (p.cwd ? [p.cwd] : []),
  // An uploader reads a file on this host in ranges (contract-attachments.ts).
  'attachment.digest': path,
  'attachment.readRange': path
}

type WireAttachment = { path: string; kind: string; textPath?: string }
/** The file paths a turn's attachments name. A `thread` reference names a
 *  session (its `path` is `thread:<id>`), not a file. */
const attachmentFiles = (p: { attachments?: WireAttachment[] }): string[] =>
  (p.attachments ?? []).filter((a) => a.kind !== 'thread').flatMap((a) => (a.textPath ? [a.path, a.textPath] : [a.path]))

/**
 * Methods whose attachments name files the harness will read. A remote
 * caller may name only paths under the managed roots or the attachment
 * directories (the thread dirs live under those roots or `<userData>/
 * attachments`, which managedRoots lists; `attachment.save`'s paste dir is
 * the extra root the server passes). A Mac path sent to the box is refused
 * here with the one typed error instead of failing inside the turn.
 */
export const ATTACHMENT_PARAMS: { [M in ClientRequest['method']]?: Picker<M> } = {
  'session.send': attachmentFiles,
  'queue.add': attachmentFiles,
  // A thumbnail read: the same roots readAttachment admits a remote caller.
  'attachment.read': path
}

/** The paths a request names, or null when the method takes none. */
export function fencedPaths(req: ClientRequest): string[] | null {
  const pick = (FENCED_PARAMS as Record<string, ((params: unknown) => string[]) | undefined>)[req.method]
  return pick ? pick((req as { params?: unknown }).params) : null
}

/** The attachment file paths a request names, or null when it takes none. */
export function attachmentPaths(req: ClientRequest): string[] | null {
  const pick = (ATTACHMENT_PARAMS as Record<string, ((params: unknown) => string[]) | undefined>)[req.method]
  return pick ? pick((req as { params?: unknown }).params) : null
}

/** Throw the typed error when a request names a path outside the roots.
 *  `attachmentRoots` widen the roots for attachment paths only. */
export function fenceRequest(req: ClientRequest, roots: readonly string[], attachmentRoots: readonly string[] = []): void {
  const paths = fencedPaths(req)
  if (paths) for (const p of paths) if (typeof p !== 'string' || !insideRoots(p, roots)) throw new FenceError(req.method)
  const files = attachmentPaths(req)
  if (!files?.length) return
  const all = [...roots, ...attachmentRoots]
  for (const p of files) if (typeof p !== 'string' || !insideRoots(p, all)) throw new FenceError(req.method)
}
