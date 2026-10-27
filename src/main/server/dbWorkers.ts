/**
 * SQLite work that leaves the main process loop (T3 Code's recipe,
 * pingdotgg/t3code 5fc1c5cb4 and 4cd0076ec, both 2026-10-14):
 *
 * - The checkpoint worker owns a second read-write connection on the hot
 *   and cold files and runs their WAL checkpoints. The writer used to do
 *   this inline every 1000 frames: copy up to 4 MB of pages into a 4 GB
 *   file and fsync it, on the loop that serves every renderer request.
 *   With the worker up the writer keeps a 10,000-frame backstop only.
 * - The reader worker (EventReader) owns a read-only connection on both
 *   files and answers session search, a json_extract walk of `events`
 *   that held the loop for 0.2–9 s on a 4 GB file. The protocol is a plain
 *   SQL executor, so other reads can follow; the writer runs the same SQL
 *   itself when the reader is not up.
 *
 * Both workers are inline source strings started with `eval: true`: no
 * bundler worker entry, nothing for vitest to resolve, the same bytes in
 * the packaged bundle. The host side is small and hands the work back to
 * the writer the moment a worker dies.
 */
import { Worker } from 'node:worker_threads'
import type { DatabaseSync } from 'node:sqlite'
import { coldPathFor } from './db'
import { recordCheckpoint } from './stalls'

/** The writer checkpoints itself only once the WAL holds this many frames
 *  (10× SQLite's default), a backstop for a worker that fell behind. */
export const WRITER_BACKSTOP_FRAMES = 10_000
/** SQLite's default: what the writer runs when no worker is checkpointing. */
export const WRITER_DEFAULT_FRAMES = 1_000
/** Frames waiting in a WAL before the worker checkpoints it. */
export const CHECKPOINT_FRAMES = 1_000
export const CHECKPOINT_POLL_MS = 100

export type CheckpointMessage =
  | { type: 'ready' }
  | { type: 'unavailable'; reason: string }
  | { type: 'checkpoint'; schema: string; frames: number; ms: number }
  | { type: 'error'; message: string }

/**
 * Runs in the worker. `PRAGMA wal_checkpoint(NOOP)` (SQLite 3.51+) reports
 * `{log, checkpointed}` without checkpointing; a PASSIVE checkpoint runs
 * when a thousand frames wait, or when writes paused with a long WAL left
 * half done so the writer's next commit cannot restart it. PASSIVE takes
 * no lock the writer waits on, and two checkpoints racing answer busy=1
 * rather than throwing.
 */
const CHECKPOINT_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const { DatabaseSync } = require('node:sqlite')
const { file, cold, frames, pollMs } = workerData
const post = (m) => parentPort.postMessage(m)
try {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA busy_timeout = 5000')
  // Plain fsync, as the writer's own inline checkpoints always used. With
  // checkpoint_fullfsync ON the worker copied 250 MB/s and fell behind a
  // 200k-row burst, so the writer's 10,000-frame backstop ran inline for
  // 250 ms; without it the worker keeps up and the loop never sees one.
  db.prepare('ATTACH DATABASE ? AS cold').run(cold)
  const version = db.prepare('SELECT sqlite_version() AS v').get().v
  const [major, minor] = version.split('.').map(Number)
  if (major < 3 || (major === 3 && minor < 51)) {
    post({ type: 'unavailable', reason: 'sqlite ' + version + ' reads NOOP as PASSIVE' })
    db.close()
  } else {
    const noop = { main: db.prepare('PRAGMA main.wal_checkpoint(NOOP)'), cold: db.prepare('PRAGMA cold.wal_checkpoint(NOOP)') }
    const passive = { main: db.prepare('PRAGMA main.wal_checkpoint(PASSIVE)'), cold: db.prepare('PRAGMA cold.wal_checkpoint(PASSIVE)') }
    const lastLog = { main: -1, cold: -1 }
    // True when a checkpoint moved frames: a burst is on, so look again at
    // once instead of letting the WAL grow for another poll interval.
    const poll = () => {
      let moved = false
      for (const schema of ['main', 'cold']) {
        const { log, checkpointed } = noop[schema].get()
        const waiting = log - checkpointed
        const stalled = log === lastLog[schema] && log >= frames && checkpointed < log
        lastLog[schema] = log
        if (waiting < frames && !stalled) continue
        const at = performance.now()
        const done = passive[schema].get()
        // A WAL pinned by a reader's snapshot makes no progress; say nothing
        // until it does (the next poll tries again).
        if (done.checkpointed > checkpointed) {
          moved = true
          post({ type: 'checkpoint', schema, frames: done.checkpointed - checkpointed, ms: performance.now() - at })
        }
      }
      return moved
    }
    let timer
    const safely = () => {
      try {
        if (poll()) setImmediate(safely)
      } catch (e) {
        clearInterval(timer)
        post({ type: 'error', message: String(e && e.message || e) })
        db.close()
      }
    }
    timer = setInterval(safely, pollMs)
    timer.unref()
    parentPort.on('message', () => {})
    post({ type: 'ready' })
  }
} catch (e) {
  post({ type: 'error', message: String(e && e.message || e) })
}
`

export interface CheckpointWorker {
  /** Resolves true once the worker checkpoints, false when it could not start. */
  ready: Promise<boolean>
  stop(): Promise<void>
}

export interface CheckpointWorkerOptions {
  frames?: number
  pollMs?: number
  /** Every checkpoint the worker ran; defaults to the stall log. */
  onCheckpoint?: (schema: string, frames: number, ms: number) => void
  log?: (line: string) => void
}

/**
 * Starts the checkpoint worker beside `db`, the writer opened on `path`.
 * On `ready` the writer's autocheckpoint moves to the backstop (one PRAGMA
 * covers hot and cold: the setting is per connection); on any end of the
 * worker it goes back to SQLite's default, once. Nothing starts for an
 * in-memory database or when workers cannot be created.
 */
export function startCheckpointWorker(
  db: DatabaseSync,
  path: string,
  options: CheckpointWorkerOptions = {}
): CheckpointWorker {
  const none: CheckpointWorker = { ready: Promise.resolve(false), stop: async () => {} }
  if (path === ':memory:') return none
  const log = options.log ?? ((line) => console.log(line))
  const onCheckpoint = options.onCheckpoint ?? recordCheckpoint
  let worker: Worker
  try {
    worker = new Worker(CHECKPOINT_WORKER_SOURCE, {
      eval: true,
      workerData: {
        file: path,
        cold: coldPathFor(path),
        frames: options.frames ?? CHECKPOINT_FRAMES,
        pollMs: options.pollMs ?? CHECKPOINT_POLL_MS
      }
    })
  } catch (error) {
    log(`[db] checkpoint worker not started: ${(error as Error).message}`)
    return none
  }
  const setAutocheckpoint = (frames: number): void => {
    try {
      db.exec(`PRAGMA wal_autocheckpoint = ${frames}`)
    } catch (error) {
      // The writer is already closed: nothing left to hand back to.
      if ((error as NodeJS.ErrnoException).code !== 'ERR_INVALID_STATE') throw error
    }
  }
  let handedBack = false
  let stopping = false
  const handBack = (why: string): void => {
    if (handedBack) return
    handedBack = true
    setAutocheckpoint(WRITER_DEFAULT_FRAMES)
    if (!stopping) log(`[db] checkpoint worker ${why}; the writer checkpoints again`)
  }
  let resolveReady!: (ok: boolean) => void
  const ready = new Promise<boolean>((resolve) => {
    resolveReady = resolve
  })
  worker.on('message', (message: CheckpointMessage) => {
    switch (message.type) {
      case 'ready':
        setAutocheckpoint(WRITER_BACKSTOP_FRAMES)
        resolveReady(true)
        return
      case 'checkpoint':
        onCheckpoint(message.schema, message.frames, message.ms)
        return
      case 'unavailable':
        handBack(message.reason)
        resolveReady(false)
        return
      case 'error':
        handBack(`failed: ${message.message}`)
        resolveReady(false)
        return
    }
  })
  worker.on('error', (error) => {
    handBack(`crashed: ${error.message}`)
    resolveReady(false)
  })
  worker.on('exit', () => {
    handBack('exited')
    resolveReady(false)
  })
  // A checkpoint in progress never holds the process open.
  worker.unref()
  let stopped: Promise<void> | null = null
  return {
    ready,
    stop: () =>
      (stopped ??= (async () => {
        stopping = true
        await worker.terminate()
      })())
  }
}

// ── reader ──────────────────────────────────────────────────────────────

/**
 * Runs in the worker: a read-only connection on the hot file with cold
 * attached, answering `{ id, sql, params }` with `{ id, rows }` or
 * `{ id, error }`. Statements are cached by SQL in a small LRU (search has
 * four shapes). A non-WAL reader's shared lock would block the writer's
 * commits, so anything but WAL reports unavailable.
 */
const READER_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const { DatabaseSync } = require('node:sqlite')
const { file, cold, cacheSize } = workerData
const post = (m) => parentPort.postMessage(m)
try {
  const db = new DatabaseSync(file, { readOnly: true })
  db.exec('PRAGMA busy_timeout = 5000')
  db.prepare('ATTACH DATABASE ? AS cold').run(cold)
  const mode = db.prepare('PRAGMA journal_mode').get().journal_mode
  if (mode !== 'wal') {
    post({ type: 'unavailable', reason: 'journal_mode is ' + mode })
    db.close()
  } else {
    const cache = new Map()
    const statement = (sql) => {
      let st = cache.get(sql)
      if (st) {
        cache.delete(sql)
      } else {
        st = db.prepare(sql)
        if (cache.size >= cacheSize) cache.delete(cache.keys().next().value)
      }
      cache.set(sql, st)
      return st
    }
    parentPort.on('message', ({ id, sql, params }) => {
      try {
        post({ id, rows: statement(sql).all(...params) })
      } catch (e) {
        post({ id, error: { message: String(e && e.message || e), code: e && e.code } })
      }
    })
    post({ type: 'ready' })
  }
} catch (e) {
  post({ type: 'error', message: String(e && e.message || e) })
}
`

type ReaderMessage =
  | { type: 'ready' }
  | { type: 'unavailable'; reason: string }
  | { type: 'error'; message: string }
  | { id: number; rows: unknown[] }
  | { id: number; error: { message: string; code?: string } }

export type SqlParam = string | number | bigint | null | Uint8Array

export interface ReaderOptions {
  cacheSize?: number
  log?: (line: string) => void
}

/**
 * The host side of the reader worker. `available` is false until the
 * worker is ready or while it restarts: pending queries reject on failure
 * and the Store uses the writer during the five-second backoff. Start it
 * after the writer opened WAL: the read-only open needs the `-shm` file
 * the writer creates.
 */
export class EventReader {
  private worker: Worker | null = null
  private pending = new Map<number, { resolve: (rows: unknown[]) => void; reject: (error: Error) => void }>()
  private nextId = 1
  private up = false
  private stopped: Promise<void> | null = null
  readonly ready: Promise<boolean>
  private restart: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly path: string, private readonly options: ReaderOptions = {}) {
    if (path === ':memory:') {
      this.ready = Promise.resolve(false)
      return
    }
    let resolveReady!: (ok: boolean) => void
    this.ready = new Promise<boolean>((resolve) => {
      resolveReady = resolve
    })
    this.start(resolveReady)
  }

  private start(resolveReady: (ok: boolean) => void = () => {}): void {
    if (this.stopped) return
    const log = this.options.log ?? ((line: string) => console.log(line))
    const retry = (): void => {
      if (this.stopped || this.restart) return
      this.restart = setTimeout(() => {
        this.restart = null
        this.start()
      }, READER_RESTART_MS)
      this.restart.unref()
    }
    let worker: Worker
    try {
      worker = new Worker(READER_WORKER_SOURCE, {
        eval: true,
        workerData: { file: this.path, cold: coldPathFor(this.path), cacheSize: this.options.cacheSize ?? 20 }
      })
    } catch (error) {
      log(`[db] reader worker not started: ${(error as Error).message}`)
      retry()
      resolveReady(false)
      return
    }
    this.worker = worker
    let ended = false
    const gone = (why: string): void => {
      if (ended || this.worker !== worker) return
      ended = true
      this.worker = null
      const was = this.up
      this.up = false
      resolveReady(false)
      for (const [id, p] of this.pending) {
        this.pending.delete(id)
        p.reject(new Error(`reader worker ${why}`))
      }
      if (was && !this.stopped) log(`[db] reader worker ${why}; retrying in 5 s`)
      void worker.terminate()
      retry()
    }
    worker.on('message', (message: ReaderMessage) => {
      if (ended || this.worker !== worker) return
      if ('id' in message) {
        const p = this.pending.get(message.id)
        if (!p) return
        this.pending.delete(message.id)
        if ('rows' in message) p.resolve(message.rows)
        else {
          const error = new Error(message.error.message) as Error & { code?: string }
          error.code = message.error.code
          p.reject(error)
        }
        return
      }
      switch (message.type) {
        case 'ready':
          this.up = true
          resolveReady(true)
          return
        case 'unavailable':
          log(`[db] reader worker unavailable: ${message.reason}; reads run on the writer`)
          gone(`unavailable: ${message.reason}`)
          return
        case 'error':
          gone(`failed: ${message.message}`)
          return
      }
    })
    worker.on('error', (error) => gone(`crashed: ${error.message}`))
    worker.on('exit', () => gone('exited'))
    worker.unref()
  }

  /** True while the worker answers; a caller with other means checks this first. */
  get available(): boolean {
    return this.up
  }

  /** Runs `sql` with `params` on the reader; rejects when the worker is
   *  gone or the statement fails (a write: "attempt to write a readonly database"). */
  query<T>(sql: string, params: SqlParam[]): Promise<T[]> {
    if (!this.up || !this.worker) return Promise.reject(new Error('reader worker not available'))
    const id = this.nextId++
    return new Promise<T[]>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (rows: unknown[]) => void, reject })
      this.worker!.postMessage({ id, sql, params })
    })
  }

  /** Rejects what is in flight (the Store answers those from the writer)
   *  and terminates the worker. terminate() cannot interrupt a statement
   *  running in SQLite, so the wait is capped: a search over the cold file
   *  can run for seconds, and shutdown does not sit behind it. */
  stop(): Promise<void> {
    return (this.stopped ??= (async () => {
      if (this.restart) clearTimeout(this.restart)
      this.restart = null
      const worker = this.worker
      this.worker = null
      this.up = false
      for (const [id, p] of this.pending) {
        this.pending.delete(id)
        p.reject(new Error('reader worker stopped'))
      }
      if (worker) {
        await Promise.race([worker.terminate(), new Promise((r) => setTimeout(r, STOP_WAIT_MS).unref())])
      }
    })())
  }
}

/** How long stop() waits for the reader's current statement to end. */
export const STOP_WAIT_MS = 2000

/** Delay before one replacement is started for a failed reader. */
export const READER_RESTART_MS = 5_000
