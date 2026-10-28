import { execFileBudgeted, statusBudget, withBudget } from './spawnBudget'
import { lstat, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative as relativePath, resolve, sep } from 'node:path'
import type { CheckpointFile, CheckpointStatus } from '@shared/contract-checkpoint'
import type { GitChangedFile } from '@shared/contract-fsgit'
import { gitDiffIndex } from './gitops'

/**
 * Per-session undo checkpoints (port of the donor's checkpoint.rs).
 *
 * `ensure` runs before every turn of a session: the first time it snapshots
 * every path already dirty against HEAD (its bytes, or its absence) so the
 * user's own edits survive an undo; each later time it refreshes that
 * baseline with the paths that became dirty since and that no turn touched,
 * which is what the person did by hand between turns (one `git diff`
 * listing per send, a snapshot per new path, no write when nothing is new).
 * A baseline path is never shown and never undone unless a turn's write
 * tool edits it, and then Undo restores the person's bytes. `record` marks
 * the paths a turn touches (snapshotting only files that do not exist yet,
 * so a late record can never freeze the agent's write as the baseline) and,
 * with `sync`, claims newly dirty paths that no other session in the same
 * project has claimed and that are not the person's baseline;
 * checkpointTurns.ts drives it from the host's own turn events.
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

/** A repo-relative path a turn touched, and whether HEAD has it (null: not asked yet). */
export interface TouchedPath {
  relative: string
  inHead: boolean | null
}

/** What a session's manifest knows: the paths its turns touched, and the
 *  paths it holds only as the person's baseline (dirty at a send, touched
 *  by no turn). */
export interface ManifestPaths {
  touched: Set<string>
  baseline: Set<string>
}
const manifestPaths = (manifest: Manifest): ManifestPaths => ({
  touched: new Set(manifest.touched),
  baseline: new Set([...manifest.files.keys()].filter((relative) => !manifest.touched.has(relative)))
})

const empty = (): CheckpointStatus => ({ files: [] })

/** What sync needs to know about every other session's manifest. */
interface IndexedManifest {
  root: string
  touched: Set<string>
}
const indexed = (manifest: Manifest): IndexedManifest => ({
  root: expandHome(manifest.cwd),
  touched: new Set(manifest.touched)
})

export class CheckpointStore {
  private readonly chains = new Map<string, Promise<unknown>>()
  /** Every manifest under root by session, read once and kept current by
   *  this store's own saves and drops. sync asks after every turn what the
   *  other sessions in the project have claimed; reading thousands of
   *  manifest dirs off disk for each answer was most of its cost. */
  private manifests: Promise<Map<string, IndexedManifest>> | null = null
  constructor(readonly root: string) {}

  /** Before a turn: the session's baseline in this cwd, made at the first
   *  send and refreshed at every later one (`refresh`). */
  ensure(sessionId: string, cwd: string): Promise<void> {
    return this.serialized(sessionId, async () => {
      const root = await projectRoot(cwd)
      const dir = this.sessionDir(sessionId)
      const existing = await readManifest(dir)
      if (existing && (await sameCwd(existing.cwd, cwd))) return this.refresh(sessionId, dir, root, existing)
      if (existing) await this.drop(sessionId)
      await mkdir(join(dir, 'files'), { recursive: true })
      const manifest: Manifest = { cwd: root, files: new Map(), touched: new Set(), tracked: new Set() }
      await snapshotBaseline(dir, root, manifest, await dirtyPaths(root))
      await this.save(sessionId, manifest)
    })
  }

  /** A later send: a path dirty now that the manifest knows neither as a
   *  snapshot nor as touched became dirty between turns, by the person's
   *  hand. It is snapshotted as their baseline, so the settle's sync never
   *  claims it and Undo never removes it; a send with nothing new writes
   *  nothing. */
  private async refresh(sessionId: string, dir: string, root: string, manifest: Manifest): Promise<void> {
    const fresh = (await dirtyPaths(root)).filter((relative) => !manifest.files.has(relative) && !manifest.touched.has(relative))
    if (fresh.length === 0) return
    await snapshotBaseline(dir, root, manifest, fresh)
    await this.save(sessionId, manifest)
  }

  /**
   * The paths a turn touched, merged into the manifest with at most one
   * write; with `sync`, also the newly dirty paths no other session in the
   * project has claimed; `forget` drops paths a turn touched that it also
   * removed (nothing to show or undo). Answers what the manifest knows
   * (its touched paths and the person's baseline paths), or null when the
   * session has no checkpoint for this cwd.
   */
  record(
    sessionId: string,
    cwd: string,
    touched: readonly TouchedPath[],
    options: { sync?: boolean; forget?: readonly string[] } = {}
  ): Promise<ManifestPaths | null> {
    return this.serialized(sessionId, async () => {
      const manifest = await this.loadMatching(sessionId, cwd)
      if (!manifest) return null
      const root = await projectRoot(cwd)
      let dirty = await markTouched(root, manifest, touched)
      for (const relative of options.forget ?? []) {
        if (manifest.touched.delete(relative)) dirty = true
        if (manifest.files.get(relative) === 'missing' && manifest.files.delete(relative)) dirty = true
      }
      if (options.sync && (await this.claimDirty(sessionId, cwd, root, manifest))) dirty = true
      if (dirty) await this.save(sessionId, manifest)
      return manifestPaths(manifest)
    })
  }

  /** Mark paths touched, asking HEAD about all of them in one git child. */
  capture(sessionId: string, cwd: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return Promise.resolve()
    return this.serialized(sessionId, async () => {
      const manifest = await this.loadMatching(sessionId, cwd)
      if (!manifest) return
      const root = await projectRoot(cwd)
      const relatives = [...new Set(paths.map((path) => relativeToRoot(root, path)))].filter((r): r is string => r !== null)
      const head = await inHeadMany(root, relatives)
      const touched = relatives.map((relative) => ({ relative, inHead: head.has(relative) }))
      if (await markTouched(root, manifest, touched)) await this.save(sessionId, manifest)
    })
  }

  async sync(sessionId: string, cwd: string): Promise<void> {
    await this.record(sessionId, cwd, [], { sync: true })
  }

  /** Claim the paths dirty now that were clean at the send (a baseline
   *  path is the person's), untouched so far and unclaimed by any other
   *  session in the project. */
  private async claimDirty(sessionId: string, cwd: string, root: string, manifest: Manifest): Promise<boolean> {
    const index = (await gitDiffIndex(root)).files
    const foreign = await this.foreignTouchedPaths(cwd, sessionId)
    const gitDirty = new Set(index.map((file) => file.relative))
    const candidates: string[] = []
    for (const file of index) {
      const relative = tryRepoPath(file.relative)
      // Dirty at a send (snapshotted as the baseline): only a record may mark these.
      if (relative === null || foreign.has(relative) || manifest.files.has(relative)) continue
      if (!manifest.touched.has(relative)) candidates.push(relative)
    }
    const head = await inHeadMany(
      root,
      candidates.filter((relative) => !manifest.tracked.has(relative))
    )
    let dirty = false
    for (const relative of candidates) {
      if (manifest.touched.size >= MAX_SNAPSHOT_FILES) break
      if (!(await fileDiffers(this.sessionDir(sessionId), root, manifest, relative, gitDirty, head))) continue
      if (head.has(relative)) manifest.tracked.add(relative)
      manifest.touched.add(relative)
      dirty = true
    }
    return dirty
  }

  /** A status already on its way for this session answers every caller
   *  that asks meanwhile (one review panel per pane, reconnects, the
   *  git-changed nudges), and its git runs on the panels' own budget. */
  private readonly statusInFlight = new Map<string, Promise<CheckpointStatus>>()

  status(sessionId: string, cwd: string): Promise<CheckpointStatus> {
    const key = `${sessionId}\0${cwd}`
    const inFlight = this.statusInFlight.get(key)
    if (inFlight) return inFlight
    const run = withBudget(statusBudget, () =>
      this.serialized(sessionId, () => this.statusUnlocked(sessionId, cwd))
    ).finally(() => {
      if (this.statusInFlight.get(key) === run) this.statusInFlight.delete(key)
    })
    this.statusInFlight.set(key, run)
    return run
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
      await this.drop(sessionId)
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
        await this.drop(sessionId)
        return empty()
      }
      const rel = repoPath(relative)
      manifest.files.set(rel, await snapshotFile(dir, root, rel))
      await this.save(sessionId, manifest)
      return this.statusUnlocked(sessionId, cwd)
    })
  }

  private async statusUnlocked(sessionId: string, cwd: string): Promise<CheckpointStatus> {
    const manifest = await this.loadMatching(sessionId, cwd)
    if (!manifest) return empty()
    const root = await projectRoot(cwd)
    return diffFromManifest(this.sessionDir(sessionId), root, manifest, sharedDiffIndex)
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
    const root = expandHome(cwd.trim())
    for (const [sessionId, entry] of await this.index()) {
      if (sessionId === exceptSessionId || entry.root !== root) continue
      for (const path of entry.touched) paths.add(path)
    }
    return paths
  }

  private index(): Promise<Map<string, IndexedManifest>> {
    this.manifests ??= (async () => {
      const map = new Map<string, IndexedManifest>()
      for (const sessionId of await readdir(this.root).catch(() => [] as string[])) {
        const manifest = await readManifest(join(this.root, sessionId)).catch(() => null)
        if (manifest) map.set(sessionId, indexed(manifest))
      }
      return map
    })()
    return this.manifests
  }

  private async save(sessionId: string, manifest: Manifest): Promise<void> {
    await writeManifest(this.sessionDir(sessionId), manifest)
    ;(await this.index()).set(sessionId, indexed(manifest))
  }

  /** Forget a session's snapshot dir: what archiving a thread does, since
   *  undo means nothing for a thread nobody will send to without reviving
   *  it first (and the dirs were most of 17 GB on one machine). Runs on
   *  the session's chain so an in-flight record cannot recreate it. */
  discard(sessionId: string): Promise<void> {
    return this.serialized(sessionId, () => this.drop(sessionId))
  }

  private async drop(sessionId: string): Promise<void> {
    await rm(this.sessionDir(sessionId), { recursive: true, force: true })
    ;(await this.index()).delete(sessionId)
  }
}

// ── status ───────────────────────────────────────────────────────────

/** One `git diff` per checkout per moment, shared by every status that
 *  asks while it runs: ten panels on the same repo cost one child. Only
 *  statuses share — ensure and record read the index fresh, since
 *  they run right after a write and must see it. */
const indexInFlight = new Map<string, Promise<GitChangedFile[]>>()
function sharedDiffIndex(root: string): Promise<GitChangedFile[]> {
  const inFlight = indexInFlight.get(root)
  if (inFlight) return inFlight
  const run = gitDiffIndex(root)
    .then((index) => index.files)
    .finally(() => {
      if (indexInFlight.get(root) === run) indexInFlight.delete(root)
    })
  indexInFlight.set(root, run)
  return run
}

async function diffFromManifest(
  dir: string,
  root: string,
  manifest: Manifest,
  readIndex: (root: string) => Promise<GitChangedFile[]> = async (r) => (await gitDiffIndex(r)).files
): Promise<CheckpointStatus> {
  const index = await readIndex(root)
  const byRelative = new Map(index.map((file) => [file.relative, file]))
  const gitDirty = new Set(byRelative.keys())
  // One git child answers "is it in HEAD" for every path that needs asking
  // (clean against the index, not yet known tracked), not one per file: a
  // status with sixty touched files used to queue sixty spawns behind the
  // app's shared child budget.
  const head = await inHeadMany(
    root,
    [...manifest.touched].filter((relative) => !gitDirty.has(relative) && !manifest.tracked.has(relative))
  )
  const files: CheckpointFile[] = []
  for (const relative of manifest.touched) {
    if (!(await fileDiffers(dir, root, manifest, relative, gitDirty, head))) continue
    files.push(await describeChange(root, relative, byRelative.get(relative)))
  }
  files.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0))
  return { files }
}

/** `head` must hold the answer for every path that is clean against the
 *  index and not in manifest.tracked (inHeadMany over that set). */
async function fileDiffers(
  dir: string,
  root: string,
  manifest: Manifest,
  relative: string,
  gitDirty: Set<string>,
  head: Set<string>
): Promise<boolean> {
  // Once a tracked path is clean against HEAD, its session change was
  // committed (or otherwise resolved) and no longer needs review.
  if (!gitDirty.has(relative) && (manifest.tracked.has(relative) || head.has(relative))) return false
  const kind = manifest.files.get(relative)
  if (kind === 'skipped') return false
  if (kind) return !sameState(await readWorktree(root, relative), await readSnapshot(dir, relative, kind))
  return gitDirty.has(relative) || ((await isFile(join(root, relative))) && !head.has(relative))
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

/** Add `touched` to the manifest; true when anything changed. The only
 *  snapshot taken here is `missing`, for a path neither HEAD nor the disk
 *  has: a late mark must never freeze the agent's write as the baseline,
 *  and a missing tracked file keeps HEAD as its baseline. */
async function markTouched(root: string, manifest: Manifest, touched: readonly TouchedPath[]): Promise<boolean> {
  let dirty = false
  for (const { relative, inHead } of touched) {
    if (manifest.touched.size >= MAX_SNAPSHOT_FILES) break
    if (!manifest.touched.has(relative)) {
      manifest.touched.add(relative)
      dirty = true
    }
    if (inHead && !manifest.tracked.has(relative)) {
      manifest.tracked.add(relative)
      dirty = true
    }
    if (inHead !== false || manifest.files.has(relative) || (await exists(join(root, relative)))) continue
    manifest.files.set(relative, 'missing')
    dirty = true
  }
  return dirty
}

/** The repo-relative paths dirty against HEAD, at most MAX_SNAPSHOT_FILES. */
async function dirtyPaths(root: string): Promise<string[]> {
  const paths: string[] = []
  for (const file of (await gitDiffIndex(root)).files) {
    if (paths.length >= MAX_SNAPSHOT_FILES) break
    const relative = tryRepoPath(file.relative)
    if (relative !== null) paths.push(relative)
  }
  return paths
}

/** Snapshot `relatives` as the person's baseline (bytes, or their absence)
 *  and note which of them HEAD has, from one git child for all of them;
 *  the manifest holds at most MAX_SNAPSHOT_FILES snapshots. */
async function snapshotBaseline(dir: string, root: string, manifest: Manifest, relatives: readonly string[]): Promise<void> {
  const head = await inHeadMany(root, [...relatives])
  for (const relative of relatives) {
    if (manifest.files.size >= MAX_SNAPSHOT_FILES) break
    if (head.has(relative)) manifest.tracked.add(relative)
    manifest.files.set(relative, await snapshotFile(dir, root, relative))
  }
}

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

/** The cwd a session's checkpoint lives under: the row's (the work cwd the
 *  thread was created in), or null when it has none to snapshot. */
export function checkpointCwd(session: { cwd?: string } | null | undefined): string | null {
  const cwd = session?.cwd?.trim()
  return cwd && cwd !== '~' ? cwd : null
}

/** The directory a checkpoint cwd names, the key its manifest is saved under. */
export const checkpointRoot = (cwd: string): string => expandHome(cwd.trim())

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
export function relativeToRoot(root: string, path: string): string | null {
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

async function git(root: string, args: string[], maxBuffer = 8 * 1024 * 1024): Promise<string> {
  try {
    const { stdout } = await execFileBudgeted('git', ['--no-pager', '-C', root, ...args], {
      maxBuffer,
      timeout: 120_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' }
    })
    return stdout
  } catch (error) {
    const e = error as Error & { stdout?: string; stderr?: string }
    throw new Error(String(e.stderr ?? '').trim() || String(e.stdout ?? '').trim() || e.message)
  }
}

/** Which of `relatives` exist in HEAD, from one git child; none without a HEAD. */
export async function inHeadMany(root: string, relatives: string[]): Promise<Set<string>> {
  if (relatives.length === 0) return new Set()
  const out = await git(root, ['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', ...relatives]).catch(() => '')
  return new Set(out.split('\0').filter(Boolean))
}

/** Every path the index tracks under `root`, from one git child; none outside a repo. */
export async function listTracked(root: string): Promise<Set<string>> {
  const out = await git(root, ['ls-files', '-z'], 64 * 1024 * 1024).catch(() => '')
  return new Set(out.split('\0').filter(Boolean))
}

const inHead = (root: string, relative: string): Promise<boolean> =>
  inHeadMany(root, [relative]).then((head) => head.has(relative))
