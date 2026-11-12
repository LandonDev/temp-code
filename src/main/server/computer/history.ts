import { appendFile, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ComputerHistoryCall, ComputerHistoryPicture, ComputerHistoryStep, HistoryPictureNone } from '@shared/contract-computer'
import { cutReadText, scrubReadText, scrubWords } from '@shared/computer/historyWords'
import type { Shot } from '@shared/computer/protocol'
import { ComputerRpcError } from './connection'
import type { Clock, ComputerService } from './service'
import { serviceSessionId } from './sessionId'

/**
 * The thread's computer journal (docs/computer-protocol.md "What the person
 * sees"): what the right panel's Computer section lists. The host that runs
 * the service writes one entry per computer call, for its own threads and
 * for a box thread's session alike (its key `macComputerKey(box, thread)`),
 * so a box thread's history sits on the Mac it drove and nothing more
 * crosses the bridge.
 *
 *   <root>/<serviceSessionId(key)>/log.jsonl      append-only, one record a line
 *   <root>/<serviceSessionId(key)>/steps/<n>.jpg  the window after call n
 *   <root>/<serviceSessionId(key)>/steps/<n>.txt  what the model read
 *
 * Three records fold into one call: `start` before it runs,
 * `end` when it answers, `picture` once the window was captured (or why it
 * was not). Nothing here can change a call's answer: every write is best
 * effort, a failure logged once and dropped. Each key has one write chain;
 * removal and the pictures switch run on it, so nothing lands after them.
 * The words are made before they get here (shared/computer/historyWords.ts),
 * under its secret rule.
 */

/** The newest calls of a thread that keep their picture and text. */
export const HISTORY_KEEP_CALLS = 400
/** The newest calls whose lines a log keeps: one found longer is written again without the rest. */
export const HISTORY_KEEP_LINES = 2_000
/** How far past the bound a log may run inside one host run before it is written again. */
export const HISTORY_COMPACT_SLACK = 200
/** A history whose log was last written this long ago is removed. */
export const HISTORY_KEEP_MS = 30 * 24 * 60 * 60 * 1000
export const HISTORY_PRUNE_EVERY_MS = 24 * 60 * 60 * 1000
/** Calls a read answers: the newest, or the ones under `before`. */
export const HISTORY_PAGE = 200
/** The kept picture's longer edge, and how long its capture may take. */
export const PICTURE_MAX_EDGE = 960
export const PICTURE_TIMEOUT_MS = 2_000
/** Settings → Computer use, "Keep pictures of the window": `0` is off, anything else on. */
export const KEEP_PICTURES_SETTING = 'computer.history.pictures'

/** Where a host keeps every thread's history, under the service's data directory. */
export const historyRoot = (computerData: string): string => join(computerData, 'history')

/**
 * Whether this instance takes pictures at all: never under
 * `TEMP_CODE_COMPUTER_HISTORY=0`, nor in a proof's instance
 * (`TEMP_CODE_E2E_STATUS=1`) unless `TEMP_CODE_COMPUTER_HISTORY=1` says so,
 * so the gate's Mac rows see no request they did not make.
 */
export function historyPicturesFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.TEMP_CODE_COMPUTER_HISTORY === '0') return false
  if (env.TEMP_CODE_E2E_STATUS === '1') return env.TEMP_CODE_COMPUTER_HISTORY === '1'
  return true
}

type PictureNone = Exclude<HistoryPictureNone, 'gone'>

/** A step as a start record holds it: `asked` is the words it takes if the call never finishes ("Click Save"). */
type StartStep = ComputerHistoryStep

interface StartRecord {
  v: 1
  r: 'start'
  n: number
  turn: number
  /** a bridged call's turn, as its box named it */
  token?: string
  at: number
  app: string
  window: string | null
  steps: StartStep[]
  plan?: string[]
}
interface EndRecord {
  v: 1
  r: 'end'
  n: number
  at: number
  app: string
  window: string | null
  steps: ComputerHistoryStep[]
  read?: string
  /** the read's text is in steps/<n>.txt */
  text?: true
}
type PictureRecord = { v: 1; r: 'picture'; n: number; at: number; width: number; height: number } | { v: 1; r: 'picture'; n: number; none: PictureNone }
type HistoryRecord = StartRecord | EndRecord | PictureRecord

/** One call as its records fold. */
interface Fold {
  n: number
  turn: number
  at: number
  endedAt?: number
  app: string
  window: string | null
  steps: StartStep[]
  plan?: string[]
  read?: string
  text: boolean
  picture?: { width: number; height: number; at: number } | { none: PictureNone }
  /** how many records made it */
  records: number
}

interface KeyState {
  key: string
  dir: string
  /** when the log's first record was written; 0 for a key with none */
  born: number
  calls: Map<number, Fold>
  /** the highest values the log holds, not its last line's */
  n: number
  turn: number
  token: string | undefined
  /** the next call of a thread this host runs starts a turn: set at load and by beginTurn */
  newTurn: boolean
  /** calls running in this process */
  open: Set<number>
  /** the names under steps/ */
  files: Set<string>
  made: boolean
  /** the log ends in a torn line (a crash mid-write): the next record starts on a line of its own */
  torn: boolean
  /** the log could not be read (anything but its absence): nothing is journaled or answered for the key until a load succeeds */
  broken: boolean
  /** removed: every job still queued does nothing */
  dead: boolean
  chain: Promise<void>
}

export interface HistoryStart {
  app: string
  window: string | null
  steps: StartStep[]
  plan?: string[]
  token?: string
  /**
   * The texts the call's steps hold back (historyWords.ts `maskedTexts`). They are never written: every string of
   * the call's start, its end and its read text goes through `held` with them before it is folded, pushed or kept.
   */
  masked?: readonly string[]
}
export interface HistoryEnd {
  app: string
  window: string | null
  steps: ComputerHistoryStep[]
  /** the read line: "Read 46 elements" */
  read?: string
  /** the read's text, kept when it says more than its header */
  text?: string
}
export type HistoryPicture = { shot: Pick<Shot, 'path' | 'width' | 'height' | 'capturedAt'> } | { none: PictureNone }

/** One call's entry: `end` when it answers, `picture` once the window was captured. Both resolve when written and never reject. */
export interface HistoryEntry {
  end(end: HistoryEnd): Promise<void>
  picture(picture: HistoryPicture): Promise<void>
  /** the call's number once its start is folded; null when its history was removed first */
  n(): Promise<number | null>
}

export type HistoryChange = { key: string; call: ComputerHistoryCall } | { key: string; gone: true }

export interface HistoryRead {
  key: string
  born: number
  calls: ComputerHistoryCall[]
  more: boolean
}

export interface HistoryStep {
  picture?: { data: string; mimeType: 'image/jpeg'; width: number; height: number; at: number }
  text?: string
}

export interface ComputerHistoryOptions {
  root: string
  now?: () => number
  log?: (line: string) => void
  /** whether pictures are kept now (the env seam and the Settings switch); default on */
  pictures?: () => boolean
}

/**
 * A record's keys no window can have written: the journal's own structure, and the strings that are the system's
 * or the host's own words whole (the app's name, a step's verb, the read's summary).
 */
const NOT_A_WINDOWS: ReadonlySet<string> = new Set(['r', 'kind', 'state', 'tier', 'token', 'none', 'app', 'verb', 'read'])

/**
 * The one place a held-back text leaves the journal (docs/computer-protocol.md §17.9 "No secret in a record"):
 * every other string a record holds, however deep, is scrubbed here (`scrubWords`), before the record is folded,
 * pushed or written, so no caller has to remember which of its strings a window could have echoed. A field added
 * to a record later is scrubbed too, unless it is named above.
 */
export function held<T>(value: T, masked: readonly string[]): T {
  if (!masked.length) return value
  const walk = (v: unknown): unknown =>
    typeof v === 'string'
      ? scrubWords(v, masked)
      : Array.isArray(v)
        ? v.map(walk)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, NOT_A_WINDOWS.has(k) ? x : walk(x)]))
          : v
  return walk(value) as T
}

/** A file or folder that is simply not there (no such entry, or a path through something that is no folder). */
const isAbsent = (e: NodeJS.ErrnoException | undefined): boolean => e?.code === 'ENOENT' || e?.code === 'ENOTDIR'

const isRecord = (v: unknown): v is HistoryRecord => {
  if (!v || typeof v !== 'object') return false
  const r = v as { v?: unknown; r?: unknown; n?: unknown }
  return r.v === 1 && (r.r === 'start' || r.r === 'end' || r.r === 'picture') && Number.isInteger(r.n) && (r.n as number) > 0
}

export class ComputerHistory {
  private readonly states = new Map<string, KeyState>()
  private readonly listeners = new Set<(change: HistoryChange) => void>()
  private readonly now: () => number
  private warned = false
  private pruneTimer: NodeJS.Timeout | null = null

  constructor(private readonly opts: ComputerHistoryOptions) {
    this.now = opts.now ?? (() => Date.now())
  }

  get root(): string {
    return this.opts.root
  }

  /** Whether a picture may be taken and kept now. */
  pictures(): boolean {
    return this.opts.pictures?.() ?? true
  }

  onChange(fn: (change: HistoryChange) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** A turn began in a thread this host runs: its next call starts a new group. A bridged call says its own turn (`token`). */
  beginTurn(key: string): void {
    const state = this.states.get(key)
    if (state) void this.run(state, async () => void (state.newTurn = true))
  }

  /** A call passed its checks: its start is written, and the entry takes its end and its picture. Never throws, never waits. */
  begin(key: string, start: HistoryStart): HistoryEntry {
    const state = this.stateOf(key)
    const at = this.now()
    const masked = start.masked ?? []
    let n: number | null = null
    const started = this.run(state, async () => {
      const fresh = start.token !== undefined ? start.token !== state.token : state.newTurn
      state.newTurn = false
      if (start.token !== undefined) state.token = start.token
      if (fresh || state.turn === 0) state.turn += 1
      n = state.n += 1
      state.open.add(n)
      const record: StartRecord = held(
        {
          v: 1,
          r: 'start',
          n,
          turn: state.turn,
          ...(start.token !== undefined ? { token: start.token } : {}),
          at,
          app: start.app,
          window: start.window,
          steps: start.steps,
          ...(start.plan?.length ? { plan: start.plan } : {})
        },
        masked
      )
      if (!state.born) state.born = at
      this.fold(state, record)
      this.changed(state, n)
      await this.append(state, record)
      await this.evict(state, n - HISTORY_KEEP_CALLS)
      // a thread that drives the Mac for days in one host run keeps its bound too
      if (state.calls.size > HISTORY_KEEP_LINES + HISTORY_COMPACT_SLACK) await this.compact(state, await this.records(state), true)
    })
    return {
      n: () => started.then(() => n),
      end: (end) =>
        this.run(state, async () => {
          if (n === null) return
          state.open.delete(n)
          // (the read text is the window's own lines: a held-back text goes wherever it stands in them)
          const text = end.text !== undefined ? cutReadText(scrubReadText(end.text, masked)) : undefined
          const kept = text !== undefined && (await this.writeStep(state, `${n}.txt`, text))
          const record: EndRecord = held(
            {
              v: 1,
              r: 'end',
              n,
              at: this.now(),
              app: end.app,
              window: end.window,
              steps: end.steps,
              ...(end.read ? { read: end.read } : {}),
              ...(kept ? { text: true as const } : {})
            },
            masked
          )
          this.fold(state, record)
          this.changed(state, n)
          await this.append(state, record)
        }),
      picture: (picture) =>
        this.run(state, async () => {
          if (n === null) return
          let record: PictureRecord
          if ('none' in picture) record = { v: 1, r: 'picture', n, none: picture.none }
          else if (!this.pictures()) record = { v: 1, r: 'picture', n, none: 'off' }
          else {
            const name = `${n}.jpg`
            const copied = await this.ensureDir(state)
              .then(() => copyFile(picture.shot.path, join(state.dir, 'steps', name)))
              .then(
                () => true,
                (e) => this.failed(e)
              )
            if (copied) state.files.add(name)
            record = copied
              ? { v: 1, r: 'picture', n, at: picture.shot.capturedAt, width: picture.shot.width, height: picture.shot.height }
              : { v: 1, r: 'picture', n, none: 'failed' }
          }
          this.fold(state, record)
          this.changed(state, n)
          await this.append(state, record)
        })
    }
  }

  /** Each key's newest calls, oldest first, or with `before` the page under that call. A key with no history answers none. */
  async read(keys: readonly string[], before?: number): Promise<HistoryRead[]> {
    const out: HistoryRead[] = []
    for (const key of keys) {
      const state = await this.kept(key)
      if (!state) {
        out.push({ key, born: 0, calls: [], more: false })
        continue
      }
      await state.chain
      // a log that could not be read is tried once more, on the key's chain, and then said: it is not "no history"
      if (state.broken && !state.dead) await (state.chain = state.chain.then(() => (state.broken && !state.dead ? this.ready(state) : undefined)))
      if (state.broken && !state.dead) throw new Error('The computer history could not be read')
      // removed while this read waited: what the state still holds is no history
      if (state.dead) {
        out.push({ key, born: 0, calls: [], more: false })
        continue
      }
      // the folds stand in the order their starts were written, which is the order of their numbers
      const all = [...state.calls.values()].filter((c) => before === undefined || c.n < before)
      const page = all.slice(-HISTORY_PAGE)
      out.push({ key, born: state.born, calls: page.map((c) => this.callOf(state, c)), more: all.length > page.length })
    }
    return out
  }

  /** One call's kept picture and read text; each absent when it was never kept or no longer is. */
  async step(key: string, n: number): Promise<HistoryStep> {
    const state = await this.kept(key)
    if (!state) return {}
    await state.chain
    if (state.broken && !state.dead) throw new Error('The computer history could not be read')
    const fold = state.dead ? undefined : state.calls.get(n)
    if (!fold) return {}
    const out: HistoryStep = {}
    const picture = fold.picture
    if (picture && !('none' in picture) && state.files.has(`${n}.jpg`)) {
      const data = await this.readStep(state, `${n}.jpg`)
      if (data) out.picture = { data: data.toString('base64'), mimeType: 'image/jpeg', width: picture.width, height: picture.height, at: picture.at }
    }
    if (fold.text && state.files.has(`${n}.txt`)) {
      const text = await this.readStep(state, `${n}.txt`)
      if (text) out.text = text.toString('utf8')
    }
    return out
  }

  /** A thread was removed: its history goes at once, and nothing queued for it lands. */
  async remove(key: string): Promise<void> {
    const state = this.states.get(key)
    const dir = this.dirOf(key)
    if (state) {
      state.chain = state.chain
        .then(async () => {
          state.dead = true
          if (this.states.get(key) === state) this.states.delete(key)
          await rm(dir, { recursive: true, force: true })
        })
        .catch((e) => void this.failed(e))
      await state.chain
    } else await rm(dir, { recursive: true, force: true }).catch((e) => void this.failed(e))
    this.emit({ key, gone: true })
  }

  /** The switch went off: every kept picture goes; the lines and the read texts stay. */
  async dropPictures(): Promise<void> {
    const loaded = new Map([...this.states.values()].map((s) => [s.dir, s]))
    for (const name of await readdir(this.opts.root).catch(() => [] as string[])) {
      const dir = join(this.opts.root, name)
      const state = loaded.get(dir)
      const drop = async (): Promise<string[]> => {
        const steps = join(dir, 'steps')
        const names = (await readdir(steps).catch(() => [] as string[])).filter((f) => f.endsWith('.jpg'))
        await Promise.all(names.map((f) => rm(join(steps, f), { force: true })))
        return names
      }
      if (!state) await drop().catch((e) => void this.failed(e))
      else
        await this.run(state, async () => {
          for (const file of await drop()) {
            state.files.delete(file)
            this.changed(state, Number(file.slice(0, -'.jpg'.length)))
          }
        })
    }
  }

  /** Histories whose log was last written 30 days ago go; one with a call in flight stays. */
  async prune(now = this.now()): Promise<void> {
    const loaded = new Map([...this.states.values()].map((s) => [s.dir, s]))
    for (const name of await readdir(this.opts.root).catch(() => [] as string[])) {
      const dir = join(this.opts.root, name)
      const info = (await stat(join(dir, 'log.jsonl')).catch(() => null)) ?? (await stat(dir).catch(() => null))
      if (!info || now - info.mtimeMs <= HISTORY_KEEP_MS) continue
      const state = loaded.get(dir)
      if (state?.open.size) continue
      if (state) await this.remove(state.key)
      else await rm(dir, { recursive: true, force: true }).catch((e) => void this.failed(e))
    }
  }

  /** Prune once soon after boot, then once a day. */
  start(): void {
    if (this.pruneTimer) return
    const first = setTimeout(() => void this.prune(), 30_000)
    first.unref()
    this.pruneTimer = setInterval(() => void this.prune(), HISTORY_PRUNE_EVERY_MS)
    this.pruneTimer.unref()
  }

  /** Everything queued is written. */
  async close(): Promise<void> {
    if (this.pruneTimer) clearInterval(this.pruneTimer)
    this.pruneTimer = null
    await Promise.all([...this.states.values()].map((s) => s.chain))
  }

  // ── one key ───────────────────────────────────────────────────────────

  private dirOf(key: string): string {
    return join(this.opts.root, serviceSessionId(key))
  }

  private stateOf(key: string): KeyState {
    let state = this.states.get(key)
    if (state) return state
    state = {
      key,
      dir: this.dirOf(key),
      born: 0,
      calls: new Map(),
      n: 0,
      turn: 0,
      token: undefined,
      newTurn: true,
      open: new Set(),
      files: new Set(),
      made: false,
      torn: false,
      broken: false,
      dead: false,
      chain: Promise.resolve()
    }
    const loading = state
    state.chain = this.ready(loading)
    this.states.set(key, state)
    return state
  }

  /** The key's state for a reader: a key with nothing on disk is not loaded, so a thread that never used the computer keeps nothing here. */
  private async kept(key: string): Promise<KeyState | null> {
    const state = this.states.get(key)
    if (state) return state
    const there = await stat(this.dirOf(key)).then(
      () => true,
      // only a folder that is not there is no history: one that cannot be looked at is loaded, and says so
      (e: NodeJS.ErrnoException) => !isAbsent(e)
    )
    if (!there) return this.states.get(key) ?? null
    return this.stateOf(key)
  }

  /**
   * The state loaded from its log, tried again if the last try failed. A
   * log that cannot be read is not an empty history: its numbers and files
   * are still on disk, and a call journaled over them as call 1 would
   * replace the thread's first. So while the load fails the key journals
   * nothing and a read of it fails (the section says so, with Retry); the
   * next job or read tries the load again.
   */
  private async ready(state: KeyState): Promise<void> {
    try {
      state.calls.clear()
      state.files.clear()
      state.born = 0
      state.n = 0
      state.turn = 0
      state.token = undefined
      await this.load(state)
      state.broken = false
    } catch (e) {
      state.broken = true
      this.failed(e)
    }
  }

  /** The log's records as they stand on disk: a torn or foreign line is skipped. No log is no records; a log that cannot be read is thrown. */
  private async records(state: KeyState): Promise<HistoryRecord[]> {
    const text = await readFile(join(state.dir, 'log.jsonl'), 'utf8').catch((e: NodeJS.ErrnoException) => {
      if (isAbsent(e)) return ''
      throw e
    })
    // a last line with no newline was cut off mid-write: what is appended next must not join it
    state.torn = text !== '' && !text.endsWith('\n')
    const records: HistoryRecord[] = []
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        const record: unknown = JSON.parse(line)
        if (isRecord(record)) records.push(record)
      } catch {
        // a torn line
      }
    }
    return records
  }

  /** The log as it stands: the counters are the highest it holds. */
  private async load(state: KeyState): Promise<void> {
    const records = await this.records(state)
    for (const record of records) {
      if (!state.born && record.r === 'start') state.born = record.at
      this.fold(state, record)
      state.n = Math.max(state.n, record.n)
      if (record.r === 'start') {
        state.turn = Math.max(state.turn, record.turn)
        if (record.token !== undefined) state.token = record.token
      }
    }
    for (const name of await readdir(join(state.dir, 'steps')).catch(() => [] as string[])) state.files.add(name)
    state.made = records.length > 0
    if (state.calls.size > HISTORY_KEEP_LINES) await this.compact(state, records, false)
  }

  /**
   * A log past its bound keeps its newest calls: it is written again beside
   * itself and swapped in, so a thread that uses the computer for months
   * never loads or folds more than that. At load `born` moves with it,
   * which tells a reader to drop the calls that went; inside a host run
   * (`live`) it stays, so a reader that holds older rows keeps them and
   * hears every new call as before.
   */
  private async compact(state: KeyState, records: readonly HistoryRecord[], live: boolean): Promise<void> {
    const floor = [...state.calls.keys()].sort((a, b) => b - a)[HISTORY_KEEP_LINES - 1]
    const keep = records.filter((r) => r.n >= floor)
    const log = join(state.dir, 'log.jsonl')
    try {
      await writeFile(`${log}.tmp`, keep.map((r) => JSON.stringify(r) + '\n').join(''))
      await rename(`${log}.tmp`, log)
      state.torn = false
    } catch (e) {
      this.failed(e)
      return
    }
    for (const n of [...state.calls.keys()]) if (n < floor) state.calls.delete(n)
    if (!live) state.born = keep.find((r): r is StartRecord => r.r === 'start')?.at ?? state.born
  }

  private fold(state: KeyState, r: HistoryRecord): void {
    const was = state.calls.get(r.n)
    if (r.r === 'start') {
      state.calls.set(r.n, {
        n: r.n,
        turn: r.turn,
        at: r.at,
        app: r.app,
        window: r.window,
        steps: r.steps,
        ...(r.plan ? { plan: r.plan } : {}),
        text: false,
        records: (was?.records ?? 0) + 1
      })
      return
    }
    // an end or a picture with no start (a torn log) is nothing to show
    if (!was) return
    if (r.r === 'end') {
      const { plan: _plan, ...rest } = was
      state.calls.set(r.n, { ...rest, endedAt: r.at, app: r.app, window: r.window, steps: r.steps, ...(r.read ? { read: r.read } : {}), text: r.text === true, records: was.records + 1 })
    } else state.calls.set(r.n, { ...was, picture: 'none' in r ? { none: r.none } : { width: r.width, height: r.height, at: r.at }, records: was.records + 1 })
  }

  /** A call as a reader gets it: whether its files are still kept is read from the directory, and a file that went counts as a revision. */
  private callOf(state: KeyState, c: Fold): ComputerHistoryCall {
    const pictureGone = c.picture !== undefined && !('none' in c.picture) && !state.files.has(`${c.n}.jpg`)
    const text = c.text && state.files.has(`${c.n}.txt`)
    const picture: ComputerHistoryPicture | undefined = pictureGone ? { none: 'gone' } : c.picture
    const unfinished = c.endedAt === undefined && !state.open.has(c.n)
    return {
      n: c.n,
      turn: c.turn,
      at: c.at,
      ...(c.endedAt !== undefined ? { endedAt: c.endedAt } : {}),
      state: c.endedAt !== undefined ? 'done' : unfinished ? 'unfinished' : 'running',
      app: c.app,
      window: c.window,
      // a call that never finished reads as what was asked of it; one that runs keeps both, for a step that waits
      steps: c.endedAt !== undefined ? c.steps : c.steps.map(({ asked, ...step }) => (unfinished ? (asked ? { ...step, ...asked } : step) : { ...step, ...(asked ? { asked } : {}) })),
      ...(c.plan ? { plan: c.plan } : {}),
      ...(c.read ? { read: c.read } : {}),
      text,
      ...(picture ? { picture } : {}),
      // every change a reader must take counts: a record, a kept file that went, and a running call found unfinished
      rev: c.records + (pictureGone ? 1 : 0) + (c.text && !text ? 1 : 0) + (unfinished ? 1 : 0)
    }
  }

  private changed(state: KeyState, n: number): void {
    const fold = state.calls.get(n)
    if (fold) this.emit({ key: state.key, call: this.callOf(state, fold) })
  }

  private emit(change: HistoryChange): void {
    for (const fn of this.listeners) {
      try {
        fn(change)
      } catch (e) {
        void this.failed(e)
      }
    }
  }

  /** The picture and text of a call past the newest 400 go; its lines stay. */
  private async evict(state: KeyState, n: number): Promise<void> {
    if (n < 1) return
    let went = false
    for (const name of [`${n}.jpg`, `${n}.txt`]) {
      if (!state.files.has(name)) continue
      await rm(join(state.dir, 'steps', name), { force: true }).catch((e) => void this.failed(e))
      state.files.delete(name)
      went = true
    }
    if (went) this.changed(state, n)
  }

  private async ensureDir(state: KeyState): Promise<void> {
    if (state.made) return
    await mkdir(join(state.dir, 'steps'), { recursive: true })
    state.made = true
  }

  private async append(state: KeyState, record: HistoryRecord): Promise<void> {
    try {
      await this.ensureDir(state)
      await appendFile(join(state.dir, 'log.jsonl'), `${state.torn ? '\n' : ''}${JSON.stringify(record)}\n`)
      state.torn = false
    } catch (e) {
      this.failed(e)
    }
  }

  private async writeStep(state: KeyState, name: string, text: string): Promise<boolean> {
    try {
      await this.ensureDir(state)
      await writeFile(join(state.dir, 'steps', name), text)
      state.files.add(name)
      return true
    } catch (e) {
      return this.failed(e)
    }
  }

  /** A kept file's bytes; null when it is gone. Any other failure to read it is thrown: the file may still be there, and the reader can ask again. */
  private async readStep(state: KeyState, name: string): Promise<Buffer | null> {
    try {
      return await readFile(join(state.dir, 'steps', name))
    } catch (e) {
      if (!isAbsent(e as NodeJS.ErrnoException)) throw e
      state.files.delete(name)
      return null
    }
  }

  /** One job on the key's chain; it runs after the log is loaded, never once the key was removed, and never rejects. */
  private run(state: KeyState, job: () => Promise<void>): Promise<void> {
    state.chain = state.chain
      .then(async () => {
        if (state.dead) return
        // a log that could not be read is tried again before anything is written over it
        if (state.broken) await this.ready(state)
        if (!state.broken) await job()
      })
      .catch((e) => void this.failed(e))
    return state.chain
  }

  /** A write failed: said once, then dropped. */
  private failed(e: unknown): false {
    if (!this.warned) {
      this.warned = true
      this.opts.log?.(`computer history: a write failed and was dropped: ${(e as Error)?.message ?? e}`)
    }
    return false
  }
}

// ── the picture ─────────────────────────────────────────────────────────

/** The window a call left, as its closing read named it: frozen, so the picture is never of another window, tab or service. */
export interface PictureTarget {
  session: string
  pid: number
  windowId: number
  /** the read's coordinate space: the whole of it is the region asked for */
  width: number
  height: number
  epoch: string
}

/**
 * One picture of the window as a call left it: `capture.screenshot` naming
 * the window by its id and a region equal to the whole coordinate space,
 * which, unlike a plain screenshot, leaves the session's space alone. No
 * request at all with Screen Recording off or once the service's epoch
 * moved (it is never started, and no session opened, for a picture); a
 * minimized window, a blank shot, a refusal, an error or two seconds
 * without an answer is a reason and nothing else.
 */
export async function capturePicture(
  service: Pick<ComputerService, 'state' | 'permissions' | 'request'>,
  target: PictureTarget | null,
  opts: { clock?: Pick<Clock, 'setTimeout' | 'clearTimeout'>; timeoutMs?: number; /** a Stop or the thread's end: the capture is given up at once */ signal?: AbortSignal } = {}
): Promise<HistoryPicture> {
  if (!target) return { none: 'no-read' }
  if (opts.signal?.aborted) return { none: 'failed' }
  if (service.permissions()?.screenRecording === false) return { none: 'permission' }
  const state = service.state()
  if (state.state !== 'up' || state.epoch !== target.epoch) return { none: 'failed' }
  const abort = new AbortController()
  const clock = opts.clock ?? { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (h: unknown) => clearTimeout(h as NodeJS.Timeout) }
  const asked: Promise<HistoryPicture> = service
    .request(
      'capture.screenshot',
      { session: target.session, app: { pid: target.pid }, window: { id: target.windowId }, region: [0, 0, target.width, target.height], maxEdge: PICTURE_MAX_EDGE, format: 'jpeg' },
      { signal: abort.signal }
    )
    .then(
      (shot): HistoryPicture => (shot.blank ? { none: 'not-drawn' } : { shot }),
      (e): HistoryPicture => {
        const kind = e instanceof ComputerRpcError ? e.data?.kind : null
        return { none: kind === 'window_minimized' ? 'minimized' : kind === 'permission_missing' ? 'permission' : 'failed' }
      }
    )
  // the bound is the thread's, not the service's: at two seconds the request is cancelled and the queue moves on,
  // whenever the service gets round to answering
  let timer: unknown
  const late = new Promise<HistoryPicture>((resolve) => {
    timer = clock.setTimeout(() => {
      abort.abort()
      resolve({ none: 'failed' })
    }, opts.timeoutMs ?? PICTURE_TIMEOUT_MS)
  })
  let cut = (): void => undefined
  const stopped = new Promise<HistoryPicture>((resolve) => {
    cut = (): void => {
      abort.abort()
      resolve({ none: 'failed' })
    }
    opts.signal?.addEventListener('abort', cut, { once: true })
  })
  try {
    return await Promise.race([asked, late, stopped])
  } finally {
    clock.clearTimeout(timer)
    opts.signal?.removeEventListener('abort', cut)
  }
}
