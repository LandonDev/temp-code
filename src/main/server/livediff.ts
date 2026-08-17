import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFileSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { watch, type FSWatcher } from 'chokidar'
import type { SessionMeta } from '@shared/events'
import type { SessionRegistry } from './sessions'

const execFileP = promisify(execFile)

/**
 * The live change stream (docs/PLAN-5.md M22): disk-truth diffs the moment
 * files change, while a session runs. Provider-agnostic — immune to harness
 * input buffering and the only source that sees shell-made changes.
 *
 * Correctness contract: diffs answer "what changed during THIS run".
 * At watcher start the already-dirty files are copied as baselines (capped);
 * clean files baseline against git HEAD; anything past the caps or binary
 * streams with diff:null (path + bytes — true, just narrower). Nothing here
 * is ever persisted: the event log stays the only durable record.
 */

export interface LiveEditPush {
  push: 'live-edit'
  cwd: string
  sessionIds: string[]
  edit: {
    path: string
    kind: 'changed' | 'created' | 'deleted'
    adds?: number
    dels?: number
    /** unified diff body; null = degraded honestly (binary/caps/burst) */
    diff: string | null
    bytes?: number
    /** flood valve: part of a mass burst — renderer rolls these up */
    burst?: boolean
    /** the per-file quiet timer fired — the edit is done */
    settled?: boolean
    ts: number
  }
}

/** Per-file baseline copy cap and total budget (rule: not bloated). */
const BASELINE_FILE_CAP = 512 * 1024
const BASELINE_TOTAL_CAP = 8 * 1024 * 1024
/** Streaming cadence and the settle quiet period. */
const FILE_DEBOUNCE_MS = 100
const SETTLE_MS = 2_000
/** Flood valve: past this many distinct paths per second, burst mode. */
const FLOOD_PATHS_PER_S = 200
const BURST_DIFF_TOP = 25
/** Grace after the last running session settles before the watcher dies. */
const STOP_GRACE_MS = 5_000
/** Repos past this many tracked files never get a watcher — the initial
 *  scan would starve the main-process event loop. */
const WATCH_FILE_CAP = 30_000

/** Mirrors the file service's ignore list (build storms, .git, app dirs). */
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

interface LiveWatch {
  cwd: string
  sessions: Set<string>
  /** sessions that settled moments ago — still own their trailing writes */
  recent: Map<string, number>
  /** rel path → owning root sessions, captured at fs-event time while the
   *  attribution is knowable (the debounced diff runs later) */
  owners: Map<string, Set<string>>
  watcher: FSWatcher
  git: boolean
  /** tmp dir holding baseline copies; removed with the watcher */
  baseDir: string
  /** rel path → baseline file on disk, 'head' (over-cap dirty), or 'empty' */
  baseline: Map<string, string | 'head' | 'empty'>
  baselineBytes: number
  timers: Map<string, ReturnType<typeof setTimeout>>
  settleTimers: Map<string, ReturnType<typeof setTimeout>>
  lastKind: Map<string, LiveEditPush['edit']['kind']>
  /** flood valve state */
  window: number[]
  burstUntil: number
  burstDiffed: Set<string>
  stopTimer: ReturnType<typeof setTimeout> | null
}

const live = new Map<string, LiveWatch>()
const listeners = new Set<(p: LiveEditPush) => void>()
/** The registry, captured on the first status callback — the ownership
 *  probe (which session is mid-write) lives there. */
let registry: SessionRegistry | null = null
/** How long a settled session still owns its trailing writes. */
const RECENT_SESSION_MS = 5_000

export function onLiveEdit(listener: (p: LiveEditPush) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const emit = (p: LiveEditPush): void => {
  for (const l of listeners) l(p)
}

const ignored = (root: string, abs: string): boolean => {
  const rel = relative(root, abs)
  if (!rel || rel.startsWith('..')) return false
  return rel.split(sep).some((seg) => WATCH_IGNORED.has(seg))
}

/** Copy current content as a baseline, within the caps. */
function tryBaselineCopy(w: LiveWatch, abs: string): string | 'head' {
  try {
    const size = statSync(abs).size
    if (size > BASELINE_FILE_CAP || w.baselineBytes + size > BASELINE_TOTAL_CAP) return 'head'
    const dest = join(w.baseDir, randomBytes(8).toString('hex'))
    copyFileSync(abs, dest)
    w.baselineBytes += size
    return dest
  } catch {
    return 'head'
  }
}

/** Materialize the git HEAD version of rel as a baseline file (or 'empty'). */
async function headBaseline(w: LiveWatch, rel: string): Promise<string | 'empty'> {
  if (!w.git) return 'empty'
  try {
    const { stdout } = await execFileP('git', ['-C', w.cwd, 'show', `HEAD:${rel}`], {
      maxBuffer: BASELINE_FILE_CAP
    })
    const dest = join(w.baseDir, randomBytes(8).toString('hex'))
    writeFileSync(dest, stdout)
    return dest
  } catch {
    return 'empty' // not in HEAD (new file) or over buffer — treat as created
  }
}

/** git diff --no-index between two files; '' when identical, null on binary. */
async function noIndexDiff(a: string, b: string): Promise<string | null> {
  try {
    await execFileP('git', ['diff', '--no-index', '--unified=3', '--', a, b], {
      maxBuffer: 4 * 1024 * 1024
    })
    return '' // exit 0 → identical
  } catch (err) {
    const out = (err as { stdout?: string }).stdout ?? ''
    if (out.includes('Binary files')) return null
    return out || null
  }
}

const countDiff = (diff: string): { adds: number; dels: number } => {
  let adds = 0
  let dels = 0
  for (const l of diff.split('\n')) {
    if (l.startsWith('+') && !l.startsWith('+++')) adds++
    else if (l.startsWith('-') && !l.startsWith('---')) dels++
  }
  return { adds, dels }
}

async function computeAndEmit(w: LiveWatch, rel: string, settled: boolean): Promise<void> {
  const kind = w.lastKind.get(rel) ?? 'changed'
  const abs = join(w.cwd, rel)
  let bytes: number | undefined
  try {
    bytes = kind === 'deleted' ? undefined : statSync(abs).size
  } catch {
    /* vanished mid-diff */
  }

  // Flood valve: during a burst only the first N paths get real diffs —
  // the rest stream honestly as path + kind + bytes.
  const now = Date.now()
  const burst =
    now < w.burstUntil && !w.burstDiffed.has(rel) && w.burstDiffed.size >= BURST_DIFF_TOP
  let diff: string | null = null
  let adds: number | undefined
  let dels: number | undefined

  if (!burst) {
    if (now < w.burstUntil) w.burstDiffed.add(rel)
    // Resolve the baseline once per path.
    let base = w.baseline.get(rel)
    if (base === undefined) {
      base = kind === 'created' ? 'empty' : await headBaseline(w, rel)
      w.baseline.set(rel, base)
    }
    if (base === 'head' && w.git) {
      // Over-cap dirty file: HEAD diff is still TRUE, just broader than
      // "this run" — the honest widening the contract allows.
      try {
        const { stdout } = await execFileP('git', ['-C', w.cwd, 'diff', 'HEAD', '--', rel], {
          maxBuffer: 4 * 1024 * 1024
        })
        diff = stdout || null
      } catch {
        diff = null
      }
    } else if (base !== 'head') {
      const baseFile = base === 'empty' ? join(w.baseDir, '.empty') : base
      const curFile = kind === 'deleted' ? join(w.baseDir, '.empty') : abs
      diff = await noIndexDiff(baseFile, curFile)
      if (diff === '') {
        // Identical to baseline — nothing actually changed; suppress
        // unless this is the settle pass (which must always close out).
        if (!settled) return
        diff = null
        adds = 0
        dels = 0
      }
    }
    if (diff) {
      const c = countDiff(diff)
      adds = c.adds
      dels = c.dels
    }
  }

  const owners = w.owners.get(rel)
  if (settled) w.owners.delete(rel)
  // Unowned changes never reach a renderer: they belong to an outside
  // writer or a thread that was not actually writing.
  if (!owners?.size) return
  emit({
    push: 'live-edit',
    cwd: w.cwd,
    sessionIds: [...owners],
    edit: {
      path: rel,
      kind,
      adds,
      dels,
      diff,
      bytes,
      burst: burst || undefined,
      settled: settled || undefined,
      ts: now
    }
  })
}

function onFsEvent(w: LiveWatch, kind: LiveEditPush['edit']['kind'], abs: string): void {
  const rel = relative(w.cwd, abs).split(sep).join('/')
  if (!rel || rel.startsWith('..')) return
  const prior = w.lastKind.get(rel)
  // created + changed in one flight stays created; anything → deleted wins.
  w.lastKind.set(rel, kind === 'changed' && prior === 'created' ? 'created' : kind)

  // Flood valve window upkeep.
  const now = Date.now()
  w.window.push(now)
  while (w.window.length && w.window[0] < now - 1000) w.window.shift()
  if (w.window.length > FLOOD_PATHS_PER_S) w.burstUntil = now + 2000

  // Ownership, captured NOW while it is knowable: the sessions actually
  // running a disk-writing tool this moment (or that settled seconds ago)
  // own the change. Attributed to the writer AND its root thread (the
  // board that displays subagent work). No owner — another thread's cwd
  // neighbor, an outside app, an IDE — means nobody renders it.
  if (registry) {
    for (const [id, t] of w.recent) if (now - t > RECENT_SESSION_MS) w.recent.delete(id)
    let owned = w.owners.get(rel)
    for (const id of [...w.sessions, ...w.recent.keys()]) {
      if (!registry.diskActiveAt(id, now)) continue
      if (!owned) {
        owned = new Set()
        w.owners.set(rel, owned)
      }
      owned.add(id)
      owned.add(registry.rootSessionOf(id))
    }
  }

  const prev = w.timers.get(rel)
  if (prev) clearTimeout(prev)
  w.timers.set(
    rel,
    setTimeout(() => {
      w.timers.delete(rel)
      void computeAndEmit(w, rel, false)
    }, FILE_DEBOUNCE_MS)
  )
  const prevSettle = w.settleTimers.get(rel)
  if (prevSettle) clearTimeout(prevSettle)
  w.settleTimers.set(
    rel,
    setTimeout(() => {
      w.settleTimers.delete(rel)
      void computeAndEmit(w, rel, true)
    }, SETTLE_MS)
  )
}

async function startWatch(cwd: string, sessionId: string): Promise<void> {
  // Key strictly by the resolved root — scheduleStop looks up w.cwd (resolved),
  // so an unresolved key would orphan the watcher.
  const root = resolve(cwd)
  const existing = live.get(root)
  if (existing) {
    existing.sessions.add(sessionId)
    if (existing.stopTimer) {
      clearTimeout(existing.stopTimer)
      existing.stopTimer = null
    }
    return
  }
  // The watcher's initial scan walks the whole tree on the main process.
  // A non-repo cwd (/tmp, a home directory) or a giant repo starves the
  // event loop — CDP, the WS server and the SDK streams all stall and
  // every thread wedges on "Working". No repo, or too many tracked files:
  // no live change stream. Everything else still works.
  let git = false
  try {
    await execFileP('git', ['-C', root, 'rev-parse', '--git-dir'])
    git = true
  } catch {
    /* non-git */
  }
  if (!git) {
    console.warn(`[livediff] ${root}: not a git repo — live change stream off`)
    return
  }
  try {
    const { stdout } = await execFileP('git', ['-C', root, 'ls-files'], {
      maxBuffer: 32 * 1024 * 1024
    })
    let files = 0
    for (let i = 0; i < stdout.length; i++) if (stdout.charCodeAt(i) === 10) files++
    if (files > WATCH_FILE_CAP) {
      console.warn(
        `[livediff] ${root}: ${files} tracked files (cap ${WATCH_FILE_CAP}) — live change stream off`
      )
      return
    }
  } catch {
    console.warn(`[livediff] ${root}: repo too large to size — live change stream off`)
    return
  }
  // The probes above awaited — a parallel session may have won the race.
  const raced = live.get(root)
  if (raced) {
    raced.sessions.add(sessionId)
    return
  }
  const baseDir = join(tmpdir(), 'temp-code-live', randomBytes(8).toString('hex'))
  mkdirSync(baseDir, { recursive: true })
  writeFileSync(join(baseDir, '.empty'), '')
  const w: LiveWatch = {
    cwd: root,
    sessions: new Set([sessionId]),
    recent: new Map(),
    owners: new Map(),
    watcher: watch(root, {
      ignored: (p) => ignored(root, p),
      ignoreInitial: true,
      persistent: true
    }),
    git,
    baseDir,
    baseline: new Map(),
    baselineBytes: 0,
    timers: new Map(),
    settleTimers: new Map(),
    lastKind: new Map(),
    window: [],
    burstUntil: 0,
    burstDiffed: new Set(),
    stopTimer: null
  }
  live.set(root, w)

  // Turn-start truth: files already dirty baseline against their CURRENT
  // content, so their diffs cover only this run (over-cap → 'head').
  if (git) {
    try {
      const { stdout } = await execFileP('git', ['-C', root, 'status', '--porcelain'], {
        maxBuffer: 4 * 1024 * 1024
      })
      for (const line of stdout.split('\n')) {
        if (!line) continue
        const rel = line.slice(3).replace(/^"|"$/g, '').split(' -> ').pop()!
        if (!rel || rel.split('/').some((seg) => WATCH_IGNORED.has(seg))) continue
        w.baseline.set(rel, tryBaselineCopy(w, join(root, rel)))
      }
    } catch {
      /* status failed — HEAD baselines still apply */
    }
  }

  w.watcher.on('add', (p) => onFsEvent(w, 'created', p))
  w.watcher.on('change', (p) => onFsEvent(w, 'changed', p))
  w.watcher.on('unlink', (p) => onFsEvent(w, 'deleted', p))
  w.watcher.on('error', () => {})
}

function scheduleStop(cwd: string): void {
  const w = live.get(cwd)
  if (!w || w.sessions.size > 0 || w.stopTimer) return
  w.stopTimer = setTimeout(() => {
    live.delete(cwd)
    for (const t of w.timers.values()) clearTimeout(t)
    for (const t of w.settleTimers.values()) clearTimeout(t)
    void w.watcher.close()
    rmSync(w.baseDir, { recursive: true, force: true })
  }, STOP_GRACE_MS)
}

/** Called by the registry on every status transition. */
export function liveDiffOnStatus(
  reg: SessionRegistry,
  meta: SessionMeta,
  prev: SessionMeta['status'] | undefined
): void {
  registry = reg
  const runningNow = meta.status === 'running' || meta.status === 'starting'
  const ranBefore = prev === 'running' || prev === 'starting'
  if (runningNow && !ranBefore) {
    void startWatch(meta.cwd, meta.id)
  } else if (!runningNow && ranBefore) {
    const w = live.get(resolve(meta.cwd)) ?? live.get(meta.cwd)
    if (w) {
      w.sessions.delete(meta.id)
      w.recent.set(meta.id, Date.now())
      scheduleStop(w.cwd)
    }
  }
}

/** Test/shutdown hook. */
export async function closeAllLiveWatchers(): Promise<void> {
  for (const [cwd, w] of live) {
    live.delete(cwd)
    if (w.stopTimer) clearTimeout(w.stopTimer)
    for (const t of w.timers.values()) clearTimeout(t)
    for (const t of w.settleTimers.values()) clearTimeout(t)
    await w.watcher.close()
    rmSync(w.baseDir, { recursive: true, force: true })
  }
}
