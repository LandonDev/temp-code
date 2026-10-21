import { randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import type { ClientRequest, ServerPush } from '@shared/contract'
import {
  MEMORY_FILES_FRAME_BYTES,
  MEMORY_FILES_PER_FRAME,
  MEMORY_MAX_WIRE_BYTES,
  type MemoryConflict,
  type MemoryEntry,
  type MemoryExchangeAnswer,
  type MemoryExchangeParams,
  type MemoryFile,
  type MemoryFilesAnswer,
  type MemoryFilesParams,
  type MemorySyncStatus
} from '@shared/contract-memory'
import type { SessionMeta } from '@shared/events'
import { LIVE_STATUSES } from '@shared/session-lifecycle'
import { remapper, stripSlash, type HistoryMapping } from '../pathMap'
import { realSpelling } from './fence'
import { decodeText, pruneEmptyDirs, sha256, type HashCache } from './harnessSet'
import { decide, pruneTombstones, unionIndex, type Decision, type LedgerRow } from './memoryMerge'
import {
  MEMORY_INDEX,
  conflictName,
  invertMapping,
  listMemory,
  mappingReadsForward,
  memoryRoot,
  memoryTranslatable,
  parseConflictName,
  stripConflict,
  translateMemoryPath
} from './memorySet'
import type { Peers } from './peers'

/**
 * Memory sync (docs/box.md "Memory: synced both ways"). The notes the
 * harnesses write for themselves (memorySet.ts) cross between every pair
 * of hosts that share an admin link, both ways, over the same peer links
 * the account and harness syncs use (peers.ts). The host holding the link
 * drives; the other decides (memoryMerge.ts):
 *
 *  - the driver, on link-up, every 5 minutes, when a thread here goes idle
 *    and when the other side nudges (a thread went idle there): lists its
 *    memory files (path, size, sha256, mode, mtime) and tombstones and
 *    sends `memory.exchange`; the receiver answers what it wants (`pull`),
 *    what the driver lands (`push`, its own files whose side won) and what
 *    the driver deletes (`remove`). The driver lands the pushes, deletes,
 *    then streams the pulls as `memory.files` frames, the last one `done`
 *    with the hashes of what it landed; the receiver lands them and
 *    answers the totals. `again` (a union result or a conflict copy the
 *    driver should have) runs one more round at once.
 *  - per file, last writer wins by mtime, with the content digest so a
 *    no-op never writes; when both sides changed since the last sync the
 *    newer wins and the other is kept beside it as `<name>.conflict-<host>-
 *    <time><ext>`, and the status says so. MEMORY.md (Claude Code's index)
 *    is unioned instead. A deletion crosses as a tombstone (kept 30 days)
 *    unless the other side edited after it.
 *  - state: `<userData>/memory-sync/state.json`: per peer, the hashes both
 *    sides agreed on last time (the ledger); and this host's tombstones.
 *  - every relPath is checked on both ends (memoryRoot): inside the set,
 *    not a secret, not a transcript, no `..`, its real parent inside the
 *    real root. An encoded project dir is translated through the path map
 *    (memorySet.ts translateEncodedDir); text files have their paths
 *    translated the way the harness sync does.
 */

export const MEMORY_ENABLED_KEY = 'memory.sync.enabled'
export const MEMORY_STATUS_KEY = 'memory.sync.status'
export const MEMORY_PERIOD_MS = 5 * 60_000
const IDLE_DEBOUNCE_MS = 3_000
const REQUEST_TIMEOUT_MS = 120_000
const STATE_VERSION = 1
/** Rounds per trigger: the first, plus one for what the receiver made (a union, a conflict copy). */
const MAX_ROUNDS = 2

type Why = 'manual' | 'periodic' | 'link-up' | 'idle' | 'nudge' | 'again'

interface State {
  version: number
  peers: Record<string, { files: Record<string, LedgerRow> }>
  tombstones: Record<string, { at: number }>
}

/** What the receiver planned for one file the driver sends. */
interface Landing {
  localRel: string
  entry: MemoryEntry
  as: 'file' | 'conflict' | 'union'
  /** 'file': this host's copy is kept beside first. */
  keepMine?: boolean
}

interface Generation {
  id: string
  from: string
  fromName: string
  mapping: HistoryMapping
  landings: Map<string, Landing>
  /** What this host sent, by its own relPath, with the hash sent: the ledger row waits for the driver's landed hash. */
  pushed: Map<string, string>
  staged: Map<string, { file: MemoryFile; data: Buffer }>
  deleted: number
  conflicts: number
  again: boolean
}

interface EnvRecord {
  files: number | null
  syncedAt: number | null
  lastAttemptAt: number | null
  error: string | null
  conflicts: number
}

export interface MemorySyncDeps {
  environmentId: string
  store: { getSetting(key: string): string | null; setSetting(key: string, value: string | null): void }
  peers: Pick<Peers, 'get' | 'all'>
  /** <userData>: the state lives under memory-sync/. */
  dataDir: string
  /** The path map the harness sync uses (harnessSync.pathMap()): read forward or backward by who sends. */
  pathMap: () => HistoryMapping
  home?: () => string
  workRoot?: () => string
  /** This host's name as a conflict copy carries it. */
  hostName?: () => string
  /** Push a frame down every link another host's main process holds to this one (a receiver's nudge). */
  nudgePeers?: (frame: ServerPush) => void
  log?: (line: string) => void
  now?: () => number
}

const within = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)

export class MemorySync {
  private readonly cache = new Map<string, { size: number; mtimeMs: number; ino: number; sha: string }>()
  private readonly syncing = new Map<string, Promise<void>>()
  private readonly again = new Set<string>()
  private readonly statuses = new Map<string, SessionMeta['status']>()
  private skipped = 0
  private periodTimer: NodeJS.Timeout | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private nudgeTimer: NodeJS.Timeout | null = null
  private generation: Generation | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false

  constructor(private readonly deps: MemorySyncDeps) {}

  private home(): string {
    return this.deps.home?.() ?? homedir()
  }

  private hostName(): string {
    return this.deps.hostName?.() ?? hostname().split('.')[0]
  }

  private log(line: string): void {
    ;(this.deps.log ?? ((l: string) => console.log(`[memory-sync] ${l}`)))(line)
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  // ── settings and status ────────────────────────────────────────────────

  enabled(): boolean {
    const raw = this.deps.store.getSetting(MEMORY_ENABLED_KEY)
    return raw === null ? true : raw === 'true'
  }

  setSettings(patch: { enabled?: boolean }): void {
    if (patch.enabled !== undefined) {
      this.deps.store.setSetting(MEMORY_ENABLED_KEY, String(patch.enabled))
      if (patch.enabled) {
        this.start()
        void this.syncAll('manual')
      } else this.stop()
    }
  }

  private records(): Record<string, EnvRecord> {
    try {
      return JSON.parse(this.deps.store.getSetting(MEMORY_STATUS_KEY) ?? '{}') as Record<string, EnvRecord>
    } catch {
      return {}
    }
  }

  private record(id: string, patch: Partial<EnvRecord>): void {
    const all = this.records()
    const blank: EnvRecord = { files: null, syncedAt: null, lastAttemptAt: null, error: null, conflicts: 0 }
    all[id] = Object.assign(blank, all[id], patch)
    this.deps.store.setSetting(MEMORY_STATUS_KEY, JSON.stringify(all))
  }

  status(): MemorySyncStatus {
    const records = this.records()
    return {
      enabled: this.enabled(),
      skipped: this.skipped,
      environments: this.deps.peers.all().map((link) => {
        const r = records[link.id]
        return {
          id: link.id,
          name: link.env.name,
          connected: link.connected,
          running: this.syncing.has(link.id),
          files: r?.files ?? null,
          syncedAt: r?.syncedAt ?? null,
          lastAttemptAt: r?.lastAttemptAt ?? null,
          error: r?.error ?? null,
          conflicts: r?.conflicts ?? 0
        }
      }),
      conflicts: this.conflicts()
    }
  }

  /** Every conflict copy in the set here, newest first. */
  conflicts(): MemoryConflict[] {
    const home = this.home()
    const out: MemoryConflict[] = []
    for (const entry of listMemory(home, { cache: this.cache as HashCache }).entries) {
      const parsed = parseConflictName(entry.relPath)
      if (!parsed) continue
      const of = join(dirname(entry.relPath), stripConflict(basename(entry.relPath)))
      out.push({ path: join(home, entry.relPath), of, host: parsed.host, at: parsed.at })
    }
    return out.sort((a, b) => b.at - a.at)
  }

  // ── triggers ───────────────────────────────────────────────────────────

  /** Sync every 5 minutes while on. */
  start(): void {
    if (this.closed || !this.enabled() || this.periodTimer) return
    this.periodTimer = setInterval(() => void this.syncAll('periodic'), MEMORY_PERIOD_MS)
    this.periodTimer.unref()
  }

  private stop(): void {
    if (this.periodTimer) clearInterval(this.periodTimer)
    this.periodTimer = null
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  /**
   * A thread's meta changed: when it settles from live to idle, memory was
   * probably just written. A driver syncs after a short quiet; a host with
   * no link of its own nudges the hosts linked to it.
   */
  onSessionMeta(meta: Pick<SessionMeta, 'id' | 'status'>): void {
    const before = this.statuses.get(meta.id)
    this.statuses.set(meta.id, meta.status)
    if (meta.status !== 'idle' || before === undefined || !LIVE_STATUSES.has(before)) return
    this.statuses.delete(meta.id)
    if (!this.enabled()) return
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      void this.syncAll('idle')
      this.deps.nudgePeers?.({ push: 'memory.nudge', from: this.deps.environmentId })
    }, IDLE_DEBOUNCE_MS)
    this.idleTimer.unref()
  }

  /** A push on a link this host holds: a nudge from the other side means a thread went idle there. */
  onPeerPush(from: string, push: ServerPush): boolean {
    if (push.push !== 'memory.nudge') return false
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer)
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null
      void this.syncWith(from, 'nudge')
    }, IDLE_DEBOUNCE_MS)
    this.nudgeTimer.unref()
    return true
  }

  async syncAll(why: Why = 'manual'): Promise<void> {
    await Promise.all(this.deps.peers.all().map((l) => this.syncWith(l.id, why)))
  }

  syncWith(environmentId: string, why: Why = 'manual'): Promise<void> {
    if (!this.enabled() || this.closed) return Promise.resolve()
    const running = this.syncing.get(environmentId)
    if (running) {
      this.again.add(environmentId)
      return running
    }
    const run = this.rounds(environmentId, why).finally(() => {
      this.syncing.delete(environmentId)
      if (this.again.delete(environmentId)) void this.syncWith(environmentId, 'again')
    })
    this.syncing.set(environmentId, run)
    return run
  }

  private async rounds(environmentId: string, why: Why): Promise<void> {
    let conflicts = 0
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const out = await this.runSync(environmentId, round === 0 ? why : 'again', conflicts)
      if (!out) return
      conflicts = out.conflicts
    }
  }

  // ── state ──────────────────────────────────────────────────────────────

  private get syncDir(): string {
    return join(this.deps.dataDir, 'memory-sync')
  }

  private loadState(): State {
    try {
      const parsed = JSON.parse(readFileSync(join(this.syncDir, 'state.json'), 'utf8')) as State
      if (parsed.version === STATE_VERSION && parsed.peers) return { version: STATE_VERSION, peers: parsed.peers, tombstones: parsed.tombstones ?? {} }
    } catch {
      /* none yet */
    }
    return { version: STATE_VERSION, peers: {}, tombstones: {} }
  }

  private saveState(state: State): void {
    mkdirSync(this.syncDir, { recursive: true, mode: 0o700 })
    const path = join(this.syncDir, 'state.json')
    const tmp = `${path}.${randomBytes(4).toString('hex')}`
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
    renameSync(tmp, path)
  }

  private ledgerOf(state: State, peer: string): Record<string, LedgerRow> {
    state.peers[peer] ??= { files: {} }
    return state.peers[peer].files
  }

  /**
   * Files the ledger says were synced with `peer` and are gone here are
   * this host's deletions: a tombstone each, dated by the dir that lost
   * them (or now), and the ledger row goes. A tombstone whose file is back
   * (the harness wrote it again) goes.
   */
  private noticeDeletions(state: State, peer: string, present: Set<string>): void {
    const ledger = this.ledgerOf(state, peer)
    const home = this.home()
    const now = this.now()
    state.tombstones = pruneTombstones(state.tombstones, now)
    for (const relPath of Object.keys(ledger)) {
      if (present.has(relPath)) continue
      if (existsSync(join(home, relPath))) continue
      let at = now
      try {
        at = Math.min(now, Math.floor(statSync(dirname(join(home, relPath))).mtimeMs))
      } catch {
        /* the dir went too */
      }
      state.tombstones[relPath] ??= { at }
      delete ledger[relPath]
    }
    for (const relPath of Object.keys(state.tombstones)) if (present.has(relPath)) delete state.tombstones[relPath]
  }

  /** The map a sender's paths land under: the harness map read forward or backward, plus the two homes and work roots. */
  translationFor(senderHome: string, senderWorkRoot?: string): HistoryMapping {
    const base = this.deps.pathMap()
    const home = stripSlash(this.home())
    const from = stripSlash(senderHome)
    const forward = mappingReadsForward(base, from, home)
    const mapped = forward ? base : invertMapping(base)
    const prefixes = { ...mapped.prefixes }
    const add = (src: string, dst: string): void => {
      if (src !== dst && !(src in prefixes) && !(src in mapped.roots)) prefixes[src] = dst
    }
    const work = this.deps.workRoot?.()
    if (forward) {
      if (work && stripSlash(work) !== home) {
        add(`${from}/IdeaProjects`, stripSlash(work))
        add(`${from}/Desktop/Websites`, stripSlash(work))
      }
    } else if (senderWorkRoot && stripSlash(senderWorkRoot) !== from) {
      // The other way round is ambiguous (IdeaProjects or Desktop/Websites); the map's roots name the known ones, IdeaProjects is the guess.
      add(stripSlash(senderWorkRoot), `${home}/IdeaProjects`)
    }
    add(from, home)
    return { roots: { ...mapped.roots }, prefixes }
  }

  /** The destination of a relPath here, or why it may not land. */
  private destination(relPath: string): { path: string; root: string } | { refused: string } {
    const root = memoryRoot(relPath)
    if (!root) return { refused: 'outside the memory set' }
    const home = this.home()
    const path = join(home, relPath)
    const rootAbs = join(home, root)
    // A root that is not there yet (a project memory dir this host has not made) is checked at its nearest existing parent.
    let probe = dirname(path)
    while (!existsSync(probe) && within(probe, rootAbs) && probe !== rootAbs) probe = dirname(probe)
    if (existsSync(rootAbs) && !within(realSpelling(probe), realSpelling(rootAbs))) return { refused: 'a symlink out of the set' }
    return { path, root: rootAbs }
  }

  /** Write bytes into place with the sender's mtime; false when the path is in the way. */
  private land(dest: string, data: Buffer, mode: number, mtime: number): boolean {
    const tmp = join(dirname(dest), `.${basename(dest)}.tc-sync-${randomBytes(4).toString('hex')}`)
    try {
      mkdirSync(dirname(dest), { recursive: true, mode: 0o755 })
      writeFileSync(tmp, data, { mode })
      chmodSync(tmp, mode)
      const t = new Date(mtime)
      utimesSync(tmp, t, t)
      renameSync(tmp, dest)
      return true
    } catch (err) {
      rmSync(tmp, { force: true })
      this.log(`could not land ${JSON.stringify(dest)} (${(err as Error).message})`)
      return false
    }
  }

  private unlink(dest: { path: string; root: string }): boolean {
    try {
      const st = lstatSync(dest.path)
      if (!st.isFile() && !st.isSymbolicLink()) return false
      unlinkSync(dest.path)
      pruneEmptyDirs(dirname(dest.path), dest.root, rmdirSync)
      return true
    } catch {
      return false
    }
  }

  /** The bytes as they land here: text files with the sender's paths translated. */
  private translated(relPath: string, data: Buffer, mapping: HistoryMapping): Buffer {
    if (!memoryTranslatable(relPath)) return data
    const text = decodeText(data)
    return text === null ? data : Buffer.from(remapper(mapping).text(text), 'utf8')
  }

  private fileOf(relPath: string, entry: MemoryEntry): MemoryFile {
    const data = readFileSync(join(this.home(), relPath))
    return { relPath, mtime: entry.mtime, sha256: sha256(data), mode: entry.mode & 0o777, dataBase64: data.toString('base64') }
  }

  // ── the driver ─────────────────────────────────────────────────────────

  /** One round with a peer: the conflict copies so far (this trigger's) when the receiver asked for another round, else null. */
  private async runSync(environmentId: string, why: Why, carried: number): Promise<{ conflicts: number } | null> {
    const link = this.deps.peers.get(environmentId)
    if (!link?.connected) return null
    const home = this.home()
    const state = this.loadState()
    const manifest = listMemory(home, { cache: this.cache as HashCache })
    this.skipped = manifest.skipped.length
    const byPath = new Map(manifest.entries.map((e) => [e.relPath, e]))
    this.noticeDeletions(state, environmentId, new Set(byPath.keys()))
    const tombstones = Object.entries(state.tombstones).map(([relPath, t]) => ({ relPath, at: t.at }))
    const generation = randomUUID()
    this.record(environmentId, { lastAttemptAt: this.now() })
    try {
      const answer = await link.request<MemoryExchangeAnswer>(
        'memory.exchange',
        {
          from: this.deps.environmentId,
          name: this.hostName(),
          home,
          ...(this.deps.workRoot ? { workRoot: this.deps.workRoot() } : {}),
          generation,
          entries: manifest.entries,
          tombstones
        },
        { timeoutMs: REQUEST_TIMEOUT_MS }
      )
      const ledger = this.ledgerOf(state, environmentId)
      // What the receiver wants, read before its pushes land (a conflict pulls the copy its push replaces), in frames of at most 200 files or 2 MiB.
      const frames: MemoryFile[][] = [[]]
      let bytes = 0
      for (const relPath of answer.pull) {
        const entry = byPath.get(relPath)
        if (!entry) throw new Error(`${link.env.name} asked for ${relPath}, which is not in the manifest`)
        const file = this.fileOf(relPath, entry)
        if (file.dataBase64.length > MEMORY_MAX_WIRE_BYTES * 2) continue
        if (frames[frames.length - 1].length >= MEMORY_FILES_PER_FRAME || bytes + file.dataBase64.length > MEMORY_FILES_FRAME_BYTES) {
          frames.push([])
          bytes = 0
        }
        frames[frames.length - 1].push(file)
        bytes += file.dataBase64.length
      }
      // The receiver's files whose side won: landed here, translated.
      const mapping = this.translationFor(answer.home, answer.workRoot)
      const landed: Record<string, string> = {}
      let written = 0
      for (const file of answer.push) {
        const data = Buffer.from(file.dataBase64, 'base64')
        if (sha256(data) !== file.sha256) throw new Error(`${file.relPath} from ${link.env.name} does not match its hash`)
        const localRel = translateMemoryPath(file.relPath, mapping)
        const dest = this.destination(localRel)
        if ('refused' in dest) {
          this.log(`refused ${JSON.stringify(file.relPath)} from ${link.env.name}: ${dest.refused}`)
          continue
        }
        const out = this.translated(localRel, data, mapping)
        const current = byPath.get(localRel)
        if (current?.sha256 === sha256(out)) {
          landed[file.relPath] = current.sha256
          ledger[localRel] = { remote: file.sha256, local: current.sha256 }
          continue
        }
        if (!this.land(dest.path, out, file.mode & 0o777, file.mtime)) continue
        const sha = sha256(out)
        landed[file.relPath] = sha
        ledger[localRel] = { remote: file.sha256, local: sha }
        delete state.tombstones[localRel]
        byPath.set(localRel, { relPath: localRel, size: out.length, sha256: sha, mode: file.mode & 0o777, mtime: file.mtime })
        written++
      }
      const removed: string[] = []
      for (const relPath of answer.remove) {
        const dest = this.destination(relPath)
        if ('refused' in dest) continue
        this.unlink(dest)
        removed.push(relPath)
        delete ledger[relPath]
        byPath.delete(relPath)
        state.tombstones[relPath] ??= { at: this.now() }
      }
      let done: MemoryFilesAnswer | null = null
      for (let i = 0; i < frames.length; i++) {
        const last = i === frames.length - 1
        const params: MemoryFilesParams = { generation, files: frames[i], done: last, ...(last ? { landed, removed } : {}) }
        const out = await link.request<MemoryFilesAnswer>('memory.files', params, { timeoutMs: REQUEST_TIMEOUT_MS })
        if (last) done = out
      }
      // The driver's ledger: what it has now, so a later deletion here is noticed.
      for (const [relPath, entry] of byPath) ledger[relPath] = { remote: ledger[relPath]?.remote ?? '', local: entry.sha256 }
      this.saveState(state)
      const result = done!
      const conflicts = carried + result.conflicts
      this.record(environmentId, { files: result.files, syncedAt: this.now(), error: null, conflicts })
      if (written || removed.length || result.written || result.deleted || result.conflicts || result.merged || answer.refused)
        this.log(
          `${link.env.name}: ${result.files} files; here ${written} written, ${removed.length} deleted; there ${result.written} written, ${result.deleted} deleted${result.merged ? `, ${result.merged} merged` : ''}${result.conflicts ? `, ${result.conflicts} conflict copies` : ''}${answer.refused ? `, ${answer.refused} refused there` : ''} (${why})`
        )
      return result.again ? { conflicts } : null
    } catch (err) {
      const message = (err as Error).message
      this.record(environmentId, { error: message })
      this.log(`${link.env.name}: sync failed (${message})`)
      return null
    }
  }

  // ── the receiver ───────────────────────────────────────────────────────

  private serial<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => {})
    return run
  }

  handleExchange(params: MemoryExchangeParams): Promise<MemoryExchangeAnswer> {
    return this.serial(() => this.exchange(params))
  }

  private exchange(params: MemoryExchangeParams): MemoryExchangeAnswer {
    if (!params.home.startsWith('/')) throw new Error('memory.exchange: home must be absolute')
    this.generation = null
    const home = this.home()
    const state = this.loadState()
    const mapping = this.translationFor(params.home, params.workRoot)
    const mine = new Map(listMemory(home, { cache: this.cache as HashCache }).entries.map((e) => [e.relPath, e]))
    this.noticeDeletions(state, params.from, new Set(mine.keys()))
    const ledger = this.ledgerOf(state, params.from)
    const fromName = params.name ?? this.deps.peers.get(params.from)?.env.name ?? params.from
    // The driver's files and tombstones, by this host's spelling of each path.
    const theirs = new Map<string, MemoryEntry>()
    const theirTombs = new Map<string, number>()
    let refused = 0
    for (const entry of params.entries) {
      const localRel = translateMemoryPath(entry.relPath, mapping)
      const dest = memoryRoot(entry.relPath) && memoryRoot(localRel) ? this.destination(localRel) : { refused: 'outside the memory set' }
      if ('refused' in dest || entry.size > MEMORY_MAX_WIRE_BYTES) {
        refused++
        this.log(`refused ${JSON.stringify(entry.relPath)} from ${fromName}: ${'refused' in dest ? dest.refused : 'over 1 MiB'}`)
        continue
      }
      theirs.set(localRel, entry)
    }
    for (const t of params.tombstones) {
      if (!memoryRoot(t.relPath)) continue
      const localRel = translateMemoryPath(t.relPath, mapping)
      if (memoryRoot(localRel) && !theirs.has(localRel)) theirTombs.set(localRel, t.at)
    }
    const paths = new Set<string>([...theirs.keys(), ...mine.keys(), ...Object.keys(ledger), ...theirTombs.keys(), ...Object.keys(state.tombstones)])
    const g: Generation = { id: params.generation, from: params.from, fromName, mapping, landings: new Map(), pushed: new Map(), staged: new Map(), deleted: 0, conflicts: 0, again: false }
    const pull: string[] = []
    const push: MemoryFile[] = []
    const remove: string[] = []
    const now = this.now()
    const sendMine = (localRel: string, entry: MemoryEntry): void => {
      const file = this.fileOf(localRel, entry)
      push.push(file)
      g.pushed.set(localRel, file.sha256)
    }
    for (const localRel of [...paths].sort()) {
      if (!memoryRoot(localRel)) continue
      const remote = theirs.get(localRel)
      const local = mine.get(localRel)
      const row = ledger[localRel]
      const d: Decision = decide({
        remote: remote ? { sha256: remote.sha256, mtime: remote.mtime } : undefined,
        remoteTombAt: theirTombs.get(localRel),
        local: local ? { sha256: local.sha256, mtime: local.mtime } : undefined,
        localTombAt: state.tombstones[localRel]?.at,
        ledger: row,
        index: MEMORY_INDEX.test(localRel)
      })
      switch (d.kind) {
        case 'nothing':
          if (remote && local) ledger[localRel] = { remote: remote.sha256, local: local.sha256 }
          else if (!remote && !local) delete ledger[localRel]
          break
        case 'pull':
          pull.push(remote!.relPath)
          g.landings.set(remote!.relPath, { localRel, entry: remote!, as: 'file', keepMine: d.keep === 'conflict' })
          delete state.tombstones[localRel]
          break
        case 'union':
          pull.push(remote!.relPath)
          g.landings.set(remote!.relPath, { localRel, entry: remote!, as: 'union' })
          break
        case 'push':
          sendMine(localRel, local!)
          if (d.keep === 'conflict') {
            pull.push(remote!.relPath)
            g.landings.set(remote!.relPath, { localRel, entry: remote!, as: 'conflict' })
          }
          break
        case 'delete-local': {
          const dest = this.destination(localRel)
          if ('refused' in dest) break
          if (d.keep === 'conflict') {
            const copy = conflictName(localRel, this.hostName(), now)
            const data = readFileSync(dest.path)
            if (this.land(join(home, copy), data, local!.mode & 0o777, local!.mtime)) {
              g.conflicts++
              sendMine(copy, { ...local!, relPath: copy })
            }
          }
          if (this.unlink(dest)) g.deleted++
          delete ledger[localRel]
          state.tombstones[localRel] = { at: theirTombs.get(localRel) ?? now }
          break
        }
        case 'delete-remote':
          remove.push(remote!.relPath)
          delete ledger[localRel]
          if (d.keep === 'conflict') {
            pull.push(remote!.relPath)
            g.landings.set(remote!.relPath, { localRel, entry: remote!, as: 'conflict' })
          }
          break
      }
    }
    this.saveState(state)
    this.generation = g
    if (g.deleted) this.log(`from ${fromName}: ${g.deleted} deleted here (its deletion won)`)
    return { generation: params.generation, name: this.hostName(), home, ...(this.deps.workRoot ? { workRoot: this.deps.workRoot() } : {}), pull, push, remove, refused }
  }

  handleFiles(params: MemoryFilesParams): Promise<MemoryFilesAnswer> {
    return this.serial(() => this.files(params))
  }

  private files(params: MemoryFilesParams): MemoryFilesAnswer {
    const g = this.generation
    if (!g || g.id !== params.generation) throw new Error('memory.files: not the current generation')
    for (const file of params.files) {
      if (!g.landings.has(file.relPath)) throw new Error(`memory.files: ${file.relPath} is not a file this generation asked for`)
      const data = Buffer.from(file.dataBase64, 'base64')
      if (sha256(data) !== file.sha256) throw new Error(`memory.files: ${file.relPath} does not match its hash`)
      g.staged.set(file.relPath, { file, data })
    }
    if (!params.done) return { files: 0, written: 0, deleted: 0, conflicts: 0, merged: 0, again: false }
    try {
      return this.commit(g, params)
    } finally {
      this.generation = null
    }
  }

  private commit(g: Generation, params: MemoryFilesParams): MemoryFilesAnswer {
    const home = this.home()
    const state = this.loadState()
    const ledger = this.ledgerOf(state, g.from)
    const now = this.now()
    let written = 0
    let merged = 0
    const theirFiles = new Set<string>()
    for (const landing of g.landings.values()) theirFiles.add(landing.localRel)
    for (const [remoteRel, landing] of g.landings) {
      const staged = g.staged.get(remoteRel)
      if (!staged) {
        // The driver skipped it (changed under it, over the budget): the next round asks again.
        continue
      }
      const dest = this.destination(landing.localRel)
      if ('refused' in dest) continue
      const out = this.translated(landing.localRel, staged.data, g.mapping)
      const outSha = sha256(out)
      const mode = staged.file.mode & 0o777
      let current: Buffer | null = null
      try {
        current = readFileSync(dest.path)
      } catch {
        current = null
      }
      if (landing.as === 'conflict') {
        const copy = join(home, conflictName(landing.localRel, g.fromName, now))
        if (this.land(copy, out, mode, staged.file.mtime)) {
          g.conflicts++
          g.again = true
        }
        continue
      }
      if (current && sha256(current) === outSha) {
        // The same bytes once translated: a no-op, remembered as synced.
        ledger[landing.localRel] = { remote: staged.file.sha256, local: outSha }
        continue
      }
      if (landing.as === 'union') {
        const theirText = decodeText(out)
        const myText = current ? decodeText(current) : null
        if (theirText === null || myText === null) {
          // Not text: the newer wins, as for any other file.
          landing.as = 'file'
          landing.keepMine = true
        } else {
          const myMtime = current ? Math.floor(statSync(dest.path).mtimeMs) : 0
          const dir = dirname(landing.localRel)
          const exists = (file: string): boolean => existsSync(join(home, dir, file)) || theirFiles.has(join(dir, file))
          const union = staged.file.mtime >= myMtime ? unionIndex(theirText, myText, exists) : unionIndex(myText, theirText, exists)
          const unionBuf = Buffer.from(union, 'utf8')
          const unionSha = sha256(unionBuf)
          if (unionSha !== sha256(current!)) {
            if (!this.land(dest.path, unionBuf, mode, Math.max(staged.file.mtime, myMtime, now))) continue
            written++
          }
          // The ledger says the driver's copy landed: the union on disk differs, so the next round sends it back.
          ledger[landing.localRel] = { remote: staged.file.sha256, local: unionSha === outSha ? unionSha : outSha }
          if (unionSha !== outSha) g.again = true
          merged++
          continue
        }
      }
      if (landing.keepMine && current) {
        const copy = join(home, conflictName(landing.localRel, this.hostName(), now))
        const st = statSync(dest.path)
        if (this.land(copy, current, st.mode & 0o777, Math.floor(st.mtimeMs))) {
          g.conflicts++
          g.again = true
        }
      }
      if (!this.land(dest.path, out, mode, staged.file.mtime)) continue
      ledger[landing.localRel] = { remote: staged.file.sha256, local: outSha }
      delete state.tombstones[landing.localRel]
      written++
    }
    // What this host sent and the driver landed: synced at the driver's hash of its (translated) copy.
    for (const [localRel, sha] of g.pushed) {
      const landed = params.landed?.[localRel]
      if (landed) ledger[localRel] = { remote: landed, local: sha }
    }
    this.saveState(state)
    const files = listMemory(home, { cache: this.cache as HashCache }).entries.length
    if (written || g.deleted || g.conflicts || merged) this.log(`from ${g.fromName}: ${written} written, ${g.deleted} deleted${merged ? `, ${merged} merged` : ''}${g.conflicts ? `, ${g.conflicts} conflict copies` : ''}`)
    return { files, written, deleted: g.deleted, conflicts: g.conflicts, merged, again: g.again }
  }

  close(): void {
    this.closed = true
    this.stop()
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer)
    this.nudgeTimer = null
  }
}

/** The `memory.*` requests, for the server's dispatch. */
export async function handleMemory(req: ClientRequest, sync: MemorySync): Promise<{ handled: true; result: unknown } | { handled: false }> {
  switch (req.method) {
    case 'memory.exchange':
      return { handled: true, result: await sync.handleExchange(req.params) }
    case 'memory.files':
      return { handled: true, result: await sync.handleFiles(req.params) }
    case 'memory.status':
      return { handled: true, result: sync.status() }
    case 'memory.sync':
      if (req.params?.environmentId) await sync.syncWith(req.params.environmentId, 'manual')
      else await sync.syncAll('manual')
      return { handled: true, result: sync.status() }
    case 'memory.settings.set':
      sync.setSettings(req.params)
      return { handled: true, result: sync.status() }
    default:
      return { handled: false }
  }
}
