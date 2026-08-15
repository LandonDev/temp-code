import { randomBytes } from 'node:crypto'
import {
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  openSync,
  readSync,
  closeSync,
  readFileSync,
  existsSync
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { watch, type FSWatcher } from 'chokidar'
import type { FsEntry, FsReadResult } from '@shared/domain'

/**
 * The file service (docs/PLAN-3.md M11). Every method is project-scoped and
 * jailed to the project cwd: resolve, then require the result under cwd.
 * `.git/` is refused outright (read and write — nothing in the app needs to
 * touch it through this door); `.temp-code/` stays readable/writable (plan
 * docs open as surfaces) but hidden from listings.
 *
 * Disk is the source of truth: writes are atomic (tmp + rename) so a reader
 * — including our own watcher-driven reload — never sees a half-written
 * file.
 */

const MAX_FILE_BYTES = 2 * 1024 * 1024

/** Directories the tree hides entirely. */
const HIDDEN = new Set(['.git', '.temp-code'])

/** Directory names the watcher ignores at any depth (build storms). */
const WATCH_IGNORED = new Set([
  '.git',
  '.temp-code',
  'node_modules',
  'target',
  'build',
  'dist',
  'out',
  '.gradle',
  '.idea',
  '.next'
])

/** Resolve a project-relative path inside cwd or throw. */
export function jail(cwd: string, relPath: string): string {
  const abs = resolve(join(cwd, relPath))
  const root = resolve(cwd)
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error('path escapes the project')
  }
  const rel = relative(root, abs)
  if (rel === '.git' || rel.startsWith(`.git${sep}`)) {
    throw new Error('.git is off limits')
  }
  return abs
}

export function fsList(cwd: string, dir: string): FsEntry[] {
  const abs = jail(cwd, dir)
  const entries: FsEntry[] = []
  for (const d of readdirSync(abs, { withFileTypes: true })) {
    if (dir === '' && HIDDEN.has(d.name)) continue
    if (d.isSymbolicLink()) continue
    if (d.isDirectory()) {
      entries.push({ name: d.name, kind: 'dir', size: 0 })
    } else if (d.isFile()) {
      let size = 0
      try {
        size = statSync(join(abs, d.name)).size
      } catch {
        continue // vanished mid-listing
      }
      entries.push({ name: d.name, kind: 'file', size })
    }
  }
  return entries.sort(
    (a, b) => Number(b.kind === 'dir') - Number(a.kind === 'dir') || a.name.localeCompare(b.name)
  )
}

/** NUL byte in the head = binary; the viewer shows a stub, not mojibake. */
function looksBinary(abs: string): boolean {
  const buf = Buffer.alloc(8192)
  const fd = openSync(abs, 'r')
  try {
    const n = readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, n).includes(0)
  } finally {
    closeSync(fd)
  }
}

export function fsRead(cwd: string, relPath: string): FsReadResult {
  const abs = jail(cwd, relPath)
  const st = statSync(abs)
  if (!st.isFile()) throw new Error('not a file')
  if (st.size > MAX_FILE_BYTES || looksBinary(abs)) {
    return { content: '', mtimeMs: st.mtimeMs, tooLarge: true }
  }
  return { content: readFileSync(abs, 'utf8'), mtimeMs: st.mtimeMs }
}

export function fsWrite(cwd: string, relPath: string, content: string): { mtimeMs: number } {
  const abs = jail(cwd, relPath)
  mkdirSync(dirname(abs), { recursive: true })
  const tmp = join(dirname(abs), `.${randomBytes(6).toString('hex')}.tc-tmp`)
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, abs)
  return { mtimeMs: statSync(abs).mtimeMs }
}

export function fsCreate(cwd: string, relPath: string, kind: 'file' | 'dir'): void {
  const abs = jail(cwd, relPath)
  if (existsSync(abs)) throw new Error('already exists')
  if (kind === 'dir') {
    mkdirSync(abs, { recursive: true })
  } else {
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, '', { flag: 'wx' })
  }
}

export function fsRename(cwd: string, relPath: string, to: string): void {
  const from = jail(cwd, relPath)
  const dest = jail(cwd, to)
  if (existsSync(dest)) throw new Error('target already exists')
  mkdirSync(dirname(dest), { recursive: true })
  renameSync(from, dest)
}

export function fsDelete(cwd: string, relPath: string): void {
  const abs = jail(cwd, relPath)
  if (abs === resolve(cwd)) throw new Error('refusing to delete the project root')
  rmSync(abs, { recursive: true, force: true })
}

// ── watcher (the spine: agent edits → open buffers, live tree, rail) ──

export interface FileEvent {
  projectId: string
  path: string
  kind: 'changed' | 'created' | 'deleted'
}

interface ProjectWatch {
  watcher: FSWatcher
  listeners: Set<(e: FileEvent) => void>
  /** per-path debounce (~100 ms) — a burst of writes coalesces to one push */
  pending: Map<string, { kind: FileEvent['kind']; timer: NodeJS.Timeout }>
}

const watches = new Map<string, ProjectWatch>()

function pathIgnored(root: string, abs: string): boolean {
  const rel = relative(root, abs)
  if (!rel || rel.startsWith('..')) return false
  return rel.split(sep).some((seg) => WATCH_IGNORED.has(seg))
}

/**
 * Refcounted per-project watcher: alive while at least one subscriber
 * (an open surface, a visible rail) cares. Returns an unsubscribe.
 */
export function subscribeFileEvents(
  projectId: string,
  cwd: string,
  listener: (e: FileEvent) => void
): () => void {
  let entry = watches.get(projectId)
  if (!entry) {
    const root = resolve(cwd)
    const watcher = watch(root, {
      ignored: (p) => pathIgnored(root, p),
      ignoreInitial: true,
      persistent: true
    })
    const created: ProjectWatch = { watcher, listeners: new Set(), pending: new Map() }
    const emit = (kind: FileEvent['kind'], abs: string): void => {
      const rel = relative(root, abs).split(sep).join('/')
      if (!rel || rel.startsWith('..')) return
      const prior = created.pending.get(rel)
      if (prior) {
        clearTimeout(prior.timer)
        // created + changed within the window is still "created"; anything
        // then deleted is "deleted".
        if (kind === 'changed' && prior.kind === 'created') kind = 'created'
      }
      const timer = setTimeout(() => {
        created.pending.delete(rel)
        for (const l of created.listeners) l({ projectId, path: rel, kind })
      }, 100)
      created.pending.set(rel, { kind, timer })
    }
    watcher.on('add', (p) => emit('created', p))
    watcher.on('change', (p) => emit('changed', p))
    watcher.on('unlink', (p) => emit('deleted', p))
    watcher.on('addDir', (p) => emit('created', p))
    watcher.on('unlinkDir', (p) => emit('deleted', p))
    watcher.on('error', () => {}) // transient fs races — the next event self-heals
    entry = created
    watches.set(projectId, entry)
  }
  entry.listeners.add(listener)
  return () => {
    const cur = watches.get(projectId)
    if (!cur) return
    cur.listeners.delete(listener)
    if (cur.listeners.size === 0) {
      for (const p of cur.pending.values()) clearTimeout(p.timer)
      void cur.watcher.close()
      watches.delete(projectId)
    }
  }
}

/** Test/shutdown hook: drop every watcher. */
export async function closeAllWatchers(): Promise<void> {
  for (const [id, w] of watches) {
    for (const p of w.pending.values()) clearTimeout(p.timer)
    await w.watcher.close()
    watches.delete(id)
  }
}
