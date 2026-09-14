import { execFileBudgeted } from './spawnBudget'
import { lstat, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative as relativePath, resolve, sep } from 'node:path'
import type { CheckpointFile, CheckpointStatus } from '@shared/contract-checkpoint'
import type { GitChangedFile } from '@shared/contract-fsgit'
import { gitDiffIndex } from './gitops'

/**
 * Per-session undo checkpoints (port of the donor's checkpoint.rs).
 *
 * `ensure` runs once per session and cwd before a turn: every path that is
 * already dirty against HEAD gets its bytes (or its absence) snapshotted so
 * the user's own edits survive an undo. `capture` marks the paths a turn
 * touches (snapshotting only files that do not exist yet, so a late capture
 * can never freeze the agent's write as the baseline); `sync` claims newly
 * dirty paths that no other live session in the same project has claimed.
 * `status` lists touched paths that still differ from their baseline;
 * `undo` restores bytes, missing state or HEAD and resets the index entry;
 * `keep` advances the baseline (one path) or drops the checkpoint (all).
 *
 * Layout: `<root>/<sessionId>/manifest.json` plus `files/<relative>` blobs.
 */

export const MAX_SNAPSHOT_FILES = 500
const MAX_TEXT_FILE_BYTES = 8 * 1024 * 1024

type SnapshotKind = 'contents' | 'missing' | 'skipped'
type FileState = { kind: 'contents'; bytes: Buffer } | { kind: 'missing' } | { kind: 'skipped' }

interface Manifest {
  cwd: string
  files: Map<string, SnapshotKind>
  touched: Set<string>
  tracked: Set<string>
}
interface ManifestJson {
  cwd: string
  files: Record<string, SnapshotKind>
  touched?: string[]
  tracked?: string[]
}

const empty = (): CheckpointStatus => ({ files: [] })

export class CheckpointStore {
  private readonly chains = new Map<string, Promise<unknown>>()
  constructor(readonly root: string) {}

  ensure(sessionId: string, cwd: string): Promise<void> {
    return this.serialized(sessionId, async () => {
      const root = await projectRoot(cwd)
      const dir = this.sessionDir(sessionId)
      const existing = await readManifest(dir)
      if (existing) {
        if (await sameCwd(existing.cwd, cwd)) return
        await rm(dir, { recursive: true, force: true })
      }
      await mkdir(join(dir, 'files'), { recursive: true })
      const manifest: Manifest = { cwd: root, files: new Map(), touched: new Set(), tracked: new Set() }
      for (const file of (await gitDiffIndex(root)).files) {
        if (manifest.files.size >= MAX_SNAPSHOT_FILES) break
        const relative = tryRepoPath(file.relative)
        if (relative === null) continue
        if (await inHead(root, relative)) manifest.tracked.add(relative)
        manifest.files.set(relative, await snapshotFile(dir, root, relative))
      }
      await writeManifest(dir, manifest)
    })
  }

  capture(sessionId: string, cwd: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return Promise.resolve()
    return this.serialized(sessionId, async () => {
      const root = await projectRoot(cwd)
      const dir = this.sessionDir(sessionId)
      const manifest = await this.loadMatching(sessionId, cwd)
      if (!manifest) return
      let dirty = false
      for (const path of paths) {
        if (manifest.touched.size >= MAX_SNAPSHOT_FILES) break
        const relative = relativeToRoot(root, path)
        if (relative === null) continue
        if (!manifest.touched.has(relative)) {
          manifest.touched.add(relative)
          dirty = true
        }
        const trackedInHead = await inHead(root, relative)
        if (trackedInHead && !manifest.tracked.has(relative)) {
          manifest.tracked.add(relative)
          dirty = true
        }
        if (manifest.files.has(relative)) continue
        // Only snapshot files that do not exist yet so a late capture cannot
        // freeze the agent's write as the baseline. A missing tracked file
        // must keep HEAD as its baseline.
        if (trackedInHead || (await exists(join(root, relative)))) continue
        manifest.files.set(relative, await snapshotFile(dir, root, relative))
        dirty = true
      }
      if (dirty) await writeManifest(dir, manifest)
    })
  }

  sync(sessionId: string, cwd: string): Promise<void> {
    return this.serialized(sessionId, async () => {
      const manifest = await this.loadMatching(sessionId, cwd)
      if (!manifest) return
      const root = await projectRoot(cwd)
      const dir = this.sessionDir(sessionId)
      const index = (await gitDiffIndex(root)).files
      const foreign = await this.foreignTouchedPaths(cwd, sessionId)
      const gitDirty = new Set(index.map((file) => file.relative))
      let dirty = false
      for (const file of index) {
        if (manifest.touched.size >= MAX_SNAPSHOT_FILES) break
        const relative = tryRepoPath(file.relative)
        if (relative === null || foreign.has(relative)) continue
        // Already dirty at ensure(): only capture() may mark these.
        if (manifest.files.has(relative)) continue
        if (!(await fileDiffers(dir, root, manifest, relative, gitDirty))) continue
        if ((await inHead(root, relative)) && !manifest.tracked.has(relative)) {
          manifest.tracked.add(relative)
          dirty = true
        }
        if (!manifest.touched.has(relative)) {
          manifest.touched.add(relative)
          dirty = true
        }
      }
      if (dirty) await writeManifest(dir, manifest)
    })
  }

  status(sessionId: string, cwd: string): Promise<CheckpointStatus> {
    return this.serialized(sessionId, () => this.statusUnlocked(sessionId, cwd))
  }

  undo(sessionId: string, cwd: string, relative?: string | null): Promise<CheckpointStatus> {
    return this.serialized(sessionId, async () => {
      const manifest = await this.loadMatching(sessionId, cwd)
      if (!manifest) return empty()
      const root = await projectRoot(cwd)
      const dir = this.sessionDir(sessionId)
      if (relative != null) {
        await restoreOne(dir, root, manifest, repoPath(relative))
        return this.statusUnlocked(sessionId, cwd)
      }
      const changed = await diffFromManifest(dir, root, manifest)
      for (const file of changed.files) await restoreOne(dir, root, manifest, file.relative)
      await rm(dir, { recursive: true, force: true })
      return empty()
    })
  }

  keep(sessionId: string, cwd: string, relative?: string | null): Promise<CheckpointStatus> {
    return this.serialized(sessionId, async () => {
      const manifest = await this.loadMatching(sessionId, cwd)
      if (!manifest) return empty()
      const root = await projectRoot(cwd)
      const dir = this.sessionDir(sessionId)
      if (relative == null) {
        await rm(dir, { recursive: true, force: true })
        return empty()
      }
      const rel = repoPath(relative)
      manifest.files.set(rel, await snapshotFile(dir, root, rel))
      await writeManifest(dir, manifest)
      return this.statusUnlocked(sessionId, cwd)
    })
  }

  private async statusUnlocked(sessionId: string, cwd: string): Promise<CheckpointStatus> {
    const manifest = await this.loadMatching(sessionId, cwd)
    if (!manifest) return empty()
    const root = await projectRoot(cwd)
    return diffFromManifest(this.sessionDir(sessionId), root, manifest)
  }

  /** One session's operations run in order; the manifest is never raced. */
  private serialized<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(sessionId) ?? Promise.resolve()
    const next = prior.then(fn, fn)
    const settled = next.then(
      () => undefined,
      () => undefined
    )
    this.chains.set(sessionId, settled)
    void settled.then(() => {
      if (this.chains.get(sessionId) === settled) this.chains.delete(sessionId)
    })
    return next
  }

  private sessionDir(sessionId: string): string {
    return join(this.root, sessionId)
  }

  private async loadMatching(sessionId: string, cwd: string): Promise<Manifest | null> {
    const manifest = await readManifest(this.sessionDir(sessionId))
    if (!manifest || !(await sameCwd(manifest.cwd, cwd))) return null
    return manifest
  }

  /** Paths already claimed by another live session in the same project. */
  private async foreignTouchedPaths(cwd: string, exceptSessionId: string): Promise<Set<string>> {
    const paths = new Set<string>()
    const entries = await readdir(this.root).catch(() => [] as string[])
    for (const sessionId of entries) {
      if (sessionId === exceptSessionId) continue
      const manifest = await readManifest(join(this.root, sessionId)).catch(() => null)
      if (!manifest || !(await sameCwd(manifest.cwd, cwd))) continue
      for (const path of manifest.touched) paths.add(path)
    }
    return paths
  }
}

// ── status ───────────────────────────────────────────────────────────

async function diffFromManifest(dir: string, root: string, manifest: Manifest): Promise<CheckpointStatus> {
  const index = (await gitDiffIndex(root)).files
  const byRelative = new Map(index.map((file) => [file.relative, file]))
  const gitDirty = new Set(byRelative.keys())
  const files: CheckpointFile[] = []
  for (const relative of manifest.touched) {
    if (!(await fileDiffers(dir, root, manifest, relative, gitDirty))) continue
    files.push(await describeChange(root, relative, byRelative.get(relative)))
  }
  files.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0))
  return { files }
}

async function fileDiffers(
  dir: string,
  root: string,
  manifest: Manifest,
  relative: string,
  gitDirty: Set<string>
): Promise<boolean> {
  // Once a tracked path is clean against HEAD, its session change was
  // committed (or otherwise resolved) and no longer needs review.
  if (!gitDirty.has(relative) && (manifest.tracked.has(relative) || (await inHead(root, relative)))) return false
  const kind = manifest.files.get(relative)
  if (kind === 'skipped') return false
  if (kind) return !sameState(await readWorktree(root, relative), await readSnapshot(dir, relative, kind))
  return gitDirty.has(relative) || ((await isFile(join(root, relative))) && !(await inHead(root, relative)))
}

async function describeChange(root: string, relative: string, git: GitChangedFile | undefined): Promise<CheckpointFile> {
  if (git) {
    const { path, status, additions, deletions } = git
    return { path, relative: git.relative, status, additions, deletions }
  }
  const path = join(root, relative)
  return { path, relative, status: (await exists(path)) ? 'modified' : 'deleted', additions: 0, deletions: 0 }
}

// ── restore ──────────────────────────────────────────────────────────

async function restoreOne(dir: string, root: string, manifest: Manifest, relative: string): Promise<void> {
  const rel = repoPath(relative)
  const kind = manifest.files.get(rel)
  if (kind === 'skipped') return
  if (kind) return restoreSnapshot(dir, root, rel, kind)
  return revertNewChange(root, rel)
}

async function restoreSnapshot(dir: string, root: string, relative: string, kind: SnapshotKind): Promise<void> {
  if (kind === 'skipped') return
  if (kind === 'missing') {
    await git(root, ['reset', '-q', 'HEAD', '--', relative]).catch(() => {})
    return removeWorktree(root, relative)
  }
  const state = await readSnapshot(dir, relative, kind)
  if (state.kind !== 'contents') return
  await writeWorktree(join(root, relative), state.bytes)
  await git(root, ['reset', '-q', 'HEAD', '--', relative]).catch(() => {})
}

async function revertNewChange(root: string, relative: string): Promise<void> {
  if (await inHead(root, relative)) {
    await git(root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', relative])
    return
  }
  await git(root, ['reset', '-q', 'HEAD', '--', relative]).catch(() => {})
  await removeWorktree(root, relative)
}

// ── snapshots ────────────────────────────────────────────────────────

async function snapshotFile(dir: string, root: string, relative: string): Promise<SnapshotKind> {
  const abs = join(root, relative)
  const meta = await stat(abs).catch(() => null)
  if (!meta) return 'missing'
  if (!meta.isFile() || meta.size > MAX_TEXT_FILE_BYTES) return 'skipped'
  const blob = blobPath(dir, relative)
  await mkdir(dirname(blob), { recursive: true })
  await writeFile(blob, await readFile(abs))
  return 'contents'
}

async function readSnapshot(dir: string, relative: string, kind: SnapshotKind): Promise<FileState> {
  if (kind !== 'contents') return { kind }
  const bytes = await readFile(blobPath(dir, relative)).catch(() => null)
  return bytes ? { kind: 'contents', bytes } : { kind: 'missing' }
}

async function readWorktree(root: string, relative: string): Promise<FileState> {
  const abs = join(root, relative)
  const meta = await stat(abs).catch(() => null)
  if (!meta) return { kind: 'missing' }
  if (!meta.isFile()) return { kind: 'skipped' }
  if (meta.size > MAX_TEXT_FILE_BYTES) return { kind: 'skipped' }
  const bytes = await readFile(abs).catch(() => null)
  return bytes ? { kind: 'contents', bytes } : { kind: 'missing' }
}

function sameState(a: FileState, b: FileState): boolean {
  if (a.kind !== b.kind) return false
  return a.kind !== 'contents' || b.kind !== 'contents' || a.bytes.equals(b.bytes)
}

async function writeWorktree(path: string, bytes: Buffer): Promise<void> {
  if (await isDir(path)) throw new Error(`${path} is a directory`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
}

async function removeWorktree(root: string, relative: string): Promise<void> {
  const abs = join(root, relative)
  const meta = await lstat(abs).catch(() => null)
  if (!meta) return
  if (meta.isFile() || meta.isSymbolicLink()) {
    await unlink(abs)
    return
  }
  if (meta.isDirectory()) {
    await git(root, ['clean', '-fd', '--', relative]).catch(() => {})
    if (await exists(abs)) await rm(abs, { recursive: true, force: true })
  }
}

function blobPath(dir: string, relative: string): string {
  return join(dir, 'files', repoPath(relative))
}

// ── manifest ─────────────────────────────────────────────────────────

async function readManifest(dir: string): Promise<Manifest | null> {
  const path = join(dir, 'manifest.json')
  if (!(await isFile(path))) return null
  const json = JSON.parse(await readFile(path, 'utf8')) as ManifestJson
  if (typeof json?.cwd !== 'string' || typeof json.files !== 'object' || json.files === null) {
    throw new Error('Invalid checkpoint manifest')
  }
  return {
    cwd: json.cwd,
    files: new Map(Object.entries(json.files)),
    touched: new Set(json.touched ?? []),
    tracked: new Set(json.tracked ?? [])
  }
}

async function writeManifest(dir: string, manifest: Manifest): Promise<void> {
  await mkdir(dir, { recursive: true })
  const sorted = (values: Iterable<string>): string[] => [...values].sort()
  const json: ManifestJson = {
    cwd: manifest.cwd,
    files: Object.fromEntries(sorted(manifest.files.keys()).map((key) => [key, manifest.files.get(key)!])),
    touched: sorted(manifest.touched),
    tracked: sorted(manifest.tracked)
  }
  const dest = join(dir, 'manifest.json')
  const tmp = join(dir, 'manifest.json.tmp')
  await writeFile(tmp, JSON.stringify(json, null, 2))
  await rename(tmp, dest)
}

// ── paths ────────────────────────────────────────────────────────────

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith(`~${sep}`)) return join(homedir(), path.slice(2))
  return resolve(path)
}

async function projectRoot(cwd: string): Promise<string> {
  const trimmed = cwd.trim()
  if (!trimmed || trimmed === '~') throw new Error('cwd is required')
  const root = expandHome(trimmed)
  if (!(await isDir(root))) throw new Error(`${root}: Not a directory`)
  return root
}

async function sameCwd(saved: string, cwd: string): Promise<boolean> {
  const [left, right] = await Promise.all([projectRoot(saved).catch(() => null), projectRoot(cwd).catch(() => null)])
  return left !== null && left === right
}

/** A repo-relative path with no empty, `.` or `..` segments; throws otherwise. */
export function repoPath(relative: string): string {
  const rel = relative.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!rel || rel.startsWith('/') || rel.includes('\0') || rel.split('/').some((part) => !part || part === '..')) {
    throw new Error('Invalid path')
  }
  return rel
}
function tryRepoPath(relative: string): string | null {
  try {
    return repoPath(relative)
  } catch {
    return null
  }
}

/** Absolute or `~` paths become repo-relative; paths outside the project are skipped. */
function relativeToRoot(root: string, path: string): string | null {
  const trimmed = path.trim()
  if (!trimmed) return null
  const expanded = trimmed === '~' || trimmed.startsWith('~/') ? expandHome(trimmed) : trimmed
  if (isAbsolute(expanded)) {
    const rel = relativePath(root, expanded)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
    return tryRepoPath(rel.split(sep).join('/'))
  }
  return tryRepoPath(expanded)
}

export function validateSessionId(value: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid session id')
}

// ── fs and git helpers ───────────────────────────────────────────────

const exists = async (path: string): Promise<boolean> => (await stat(path).catch(() => null)) !== null
const isFile = async (path: string): Promise<boolean> => (await stat(path).catch(() => null))?.isFile() ?? false
const isDir = async (path: string): Promise<boolean> => (await stat(path).catch(() => null))?.isDirectory() ?? false

async function git(root: string, args: string[]): Promise<void> {
  try {
    await execFileBudgeted('git', ['--no-pager', '-C', root, ...args], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 120_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' }
    })
  } catch (error) {
    const e = error as Error & { stdout?: string; stderr?: string }
    throw new Error(String(e.stderr ?? '').trim() || String(e.stdout ?? '').trim() || e.message)
  }
}

const inHead = (root: string, relative: string): Promise<boolean> =>
  git(root, ['cat-file', '-e', `HEAD:${relative}`]).then(
    () => true,
    () => false
  )
