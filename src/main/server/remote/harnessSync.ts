import { randomBytes, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  watch,
  writeFileSync,
  type FSWatcher
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import type { ClientRequest } from '@shared/contract'
import {
  HARNESS_CHUNK_BYTES,
  type HarnessClaudeJson,
  type HarnessCommitAnswer,
  type HarnessEntry,
  type HarnessFileParams,
  type HarnessManifestAnswer,
  type HarnessManifestParams,
  type HarnessSyncStatus
} from '@shared/contract-harness'
import historyMap from '../../../../scripts/box/history-map.json'
import { parseMapping, remapper, stripSlash, type HistoryMapping } from '../pathMap'
import { realSpelling } from './fence'
import {
  CLAUDE_JSON,
  HARNESS_CLAUDE_KEYS,
  HARNESS_SET,
  buildManifest,
  decodeText,
  isMachO,
  isSecretPath,
  missingHookExecutables,
  pruneEmptyDirs,
  ruleFor,
  ruleRoot,
  setCounts,
  sha256,
  translatable,
  type HashCache,
  type SetRule
} from './harnessSet'
import type { Peers } from './peers'

/**
 * Harness config sync (docs/box.md "Harness config: synced from the Mac").
 * The Mac is the source of truth for what the user configured for Claude
 * Code and Codex; its main process mirrors the sync set (harnessSet.ts)
 * onto every host it holds an admin key for, over the same peer links the
 * account sync uses (peers.ts). A host never pushes back: the box has no
 * link to the Mac, and a headless host does not send unless told to.
 *
 *  - as the sender, on link-up, on a debounced watch of the set and every
 *    15 minutes: build the manifest {relPath, size, sha256, mode, mtime}
 *    (hashes cached by inode and mtime), send `harness.manifest`, stream
 *    what the receiver asks for as `harness.file` chunks, then
 *    `harness.commit`. The result per host is the status the Settings →
 *    Remote access pane shows.
 *  - as the receiver: answer a manifest with what it needs (new, changed
 *    on the sender, edited here since it landed, or translated under an
 *    older map) and what it will delete (what an earlier manifest landed
 *    and this one no longer lists: a file this host made itself inside the
 *    set is never deleted). Chunks wait in `<userData>/harness-sync/
 *    staging/<generation>`; the commit checks every file whole against its
 *    hash, translates the text ones (pathMap.ts: the sender's home, its
 *    IdeaProjects and Desktop/Websites, and the `harness.sync.pathMap`
 *    setting, the shipped history-map.json by default) and swaps each into
 *    place with a rename, deletes, merges the two ~/.claude.json keys, and
 *    records what it landed in the ledger. A newer manifest discards a
 *    generation that never committed.
 *  - every relPath is checked on both ends: inside the set, not a secret,
 *    no `..`, not absolute, and its real parent inside the real rule root
 *    (no landing through a symlink that points out). A refusal is logged
 *    and the file never lands. A Mach-O file (isMachO) is left out of the
 *    manifest and refused again on commit: a macOS binary runs nowhere else.
 */

export const ENABLED_KEY = 'harness.sync.enabled'
export const STATUS_KEY = 'harness.sync.status'
export const PATH_MAP_KEY = 'harness.sync.pathMap'
export const PERIOD_MS = 15 * 60_000
const WATCH_DEBOUNCE_MS = 2_000
/** A chunk is up to 2 MiB over a tunnel; the default 30 s is short for that. */
const CHUNK_TIMEOUT_MS = 120_000
const MANIFEST_TIMEOUT_MS = 120_000
const LEDGER_VERSION = 1

export const DEFAULT_PATH_MAP: HistoryMapping = parseMapping(JSON.stringify(historyMap))

interface LedgerEntry {
  /** The sender's hash of the file. */
  src: string
  /** The hash of what landed here (differs from src when translated). */
  landed: string
  size: number
  mtimeMs: number
  mode: number
  /** The translation it landed under ('' when copied byte for byte). */
  tx: string
}

interface Ledger {
  version: number
  from: string | null
  files: Record<string, LedgerEntry>
  /** The ~/.claude.json keys a sync wrote, so a key the sender dropped is dropped here too. */
  claudeKeys: string[]
}

interface Generation {
  id: string
  from: string
  home: string
  entries: Map<string, HarnessEntry>
  need: Set<string>
  remove: string[]
  claudeJson?: HarnessClaudeJson
  dir: string
  chunks: Map<string, { total: number; got: Set<number> }>
}

interface EnvRecord {
  files: number | null
  /** Files per set label in the last manifest the host committed. */
  sets: Record<string, number> | null
  syncedAt: number | null
  lastAttemptAt: number | null
  error: string | null
}

export interface HarnessSyncDeps {
  environmentId: string
  store: { getSetting(key: string): string | null; setSetting(key: string, value: string | null): void }
  peers: Pick<Peers, 'get' | 'all'>
  /** <userData>: the receiver's ledger and staging live under harness-sync/. */
  dataDir: string
  /** Sending is on unless the setting says otherwise; a headless host defaults to off (it receives). */
  defaultEnabled: boolean
  home?: () => string
  /** Where the receiver's workspaces live (workRoot.ts): IdeaProjects/X and Desktop/Websites/X land under it. */
  workRoot?: () => string
  rules?: readonly SetRule[]
  log?: (line: string) => void
  now?: () => number
  /** The PATH the receiver checks hook executables against. */
  pathEnv?: () => string | undefined
}

const within = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)


/** A loopback address in the sender's `env` (its own proxy or shim) reaches nothing on this host; the CLI's own default is right here. */
const LOOPBACK = /(^|[^\w.])(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])([^\w.]|$)/i

/** `settings.json` without the `env` entries that point at the sender's loopback; the text as it was when nothing is dropped. */
export function stripHostBoundEnv(text: string): { text: string; dropped: string[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { text, dropped: [] }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { text, dropped: [] }
  const settings = parsed as Record<string, unknown>
  const env = settings.env
  if (!env || typeof env !== 'object' || Array.isArray(env)) return { text, dropped: [] }
  const kept: Record<string, unknown> = {}
  const dropped: string[] = []
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (typeof value === 'string' && LOOPBACK.test(value)) dropped.push(key)
    else kept[key] = value
  }
  if (!dropped.length) return { text, dropped }
  if (Object.keys(kept).length) settings.env = kept
  else delete settings.env
  return { text: JSON.stringify(settings, null, 2) + '\n', dropped }
}

/** `config.toml` without top-level `*base_url` lines that point at the sender's loopback (Aliax's shim); the per-thread URL the driver passes is right here. Lines only: a TOML parse is not needed for a key = "string" at the top level. */
export function stripHostBoundToml(text: string): { text: string; dropped: string[] } {
  const dropped: string[] = []
  const lines = text.split('\n')
  let inTable = false
  const kept = lines.filter((line) => {
    const t = line.trim()
    if (t.startsWith('[')) inTable = true
    if (inTable) return true
    const m = t.match(/^([A-Za-z0-9_]*base_url)\s*=\s*"([^"]*)"/)
    if (m && LOOPBACK.test(m[2])) {
      dropped.push(m[1])
      return false
    }
    return true
  })
  return dropped.length ? { text: kept.join('\n'), dropped } : { text, dropped }
}

export class HarnessSync {
  private readonly cache = new Map<string, { size: number; mtimeMs: number; ino: number; sha: string }>()
  private readonly syncing = new Map<string, Promise<void>>()
  private readonly again = new Set<string>()
  /** Per host, the digest of the last manifest it committed: a watch event with nothing new sends nothing. */
  private readonly lastDigest = new Map<string, string>()
  private skipped = 0
  private watchers: FSWatcher[] = []
  private watchTimer: NodeJS.Timeout | null = null
  private periodTimer: NodeJS.Timeout | null = null
  private generation: Generation | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false

  constructor(private readonly deps: HarnessSyncDeps) {}

  private get rules(): readonly SetRule[] {
    return this.deps.rules ?? HARNESS_SET
  }

  private home(): string {
    return this.deps.home?.() ?? homedir()
  }

  private log(line: string): void {
    ;(this.deps.log ?? ((l: string) => console.log(`[harness-sync] ${l}`)))(line)
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  // ── settings and status ────────────────────────────────────────────────

  enabled(): boolean {
    const raw = this.deps.store.getSetting(ENABLED_KEY)
    return raw === null ? this.deps.defaultEnabled : raw === 'true'
  }

  pathMap(): HistoryMapping {
    const raw = this.deps.store.getSetting(PATH_MAP_KEY)
    if (!raw) return DEFAULT_PATH_MAP
    try {
      return parseMapping(raw)
    } catch (err) {
      this.log(`${PATH_MAP_KEY} is not a mapping (${(err as Error).message}); using the shipped map`)
      return DEFAULT_PATH_MAP
    }
  }

  setSettings(patch: { enabled?: boolean; pathMap?: Partial<HistoryMapping> | null }): void {
    if (patch.pathMap !== undefined) {
      // parseMapping throws on anything but absolute → absolute: the caller hears why.
      this.deps.store.setSetting(PATH_MAP_KEY, patch.pathMap === null ? null : JSON.stringify(parseMapping(JSON.stringify(patch.pathMap))))
    }
    if (patch.enabled !== undefined) {
      this.deps.store.setSetting(ENABLED_KEY, String(patch.enabled))
      if (patch.enabled) {
        this.start()
        void this.syncAll('manual')
      } else this.stopWatching()
    }
  }

  private records(): Record<string, EnvRecord> {
    try {
      return JSON.parse(this.deps.store.getSetting(STATUS_KEY) ?? '{}') as Record<string, EnvRecord>
    } catch {
      return {}
    }
  }

  private record(id: string, patch: Partial<EnvRecord>): void {
    const all = this.records()
    const blank: EnvRecord = { files: null, sets: null, syncedAt: null, lastAttemptAt: null, error: null }
    all[id] = Object.assign(blank, all[id], patch)
    this.deps.store.setSetting(STATUS_KEY, JSON.stringify(all))
  }

  status(): HarnessSyncStatus {
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
          sets: r?.sets ?? null,
          syncedAt: r?.syncedAt ?? null,
          lastAttemptAt: r?.lastAttemptAt ?? null,
          error: r?.error ?? null
        }
      })
    }
  }

  // ── the sender ─────────────────────────────────────────────────────────

  /** Watch the set and sync every 15 minutes while sending is on. */
  start(): void {
    if (this.closed || !this.enabled()) return
    if (!this.periodTimer) {
      this.periodTimer = setInterval(() => {
        this.armWatchers()
        void this.syncAll('periodic')
      }, PERIOD_MS)
      this.periodTimer.unref()
    }
    this.armWatchers()
  }

  private stopWatching(): void {
    for (const w of this.watchers) w.close()
    this.watchers = []
    if (this.periodTimer) clearInterval(this.periodTimer)
    this.periodTimer = null
    if (this.watchTimer) clearTimeout(this.watchTimer)
    this.watchTimer = null
  }

  /** One watcher per rule root (recursive) and per file rule's dir, plus HOME for ~/.claude.json; a root that appears later is picked up on the next period. */
  private armWatchers(): void {
    for (const w of this.watchers) w.close()
    this.watchers = []
    const home = this.home()
    const targets = new Map<string, { recursive: boolean; names: Set<string> | null }>()
    for (const rule of this.rules) {
      if (rule.kind === 'tree') targets.set(join(home, rule.root), { recursive: true, names: null })
      else {
        const dir = join(home, dirname(rule.path))
        const t = targets.get(dir) ?? { recursive: false, names: new Set<string>() }
        t.names?.add(basename(rule.path))
        targets.set(dir, t)
      }
    }
    const homeTarget = targets.get(home) ?? { recursive: false, names: new Set<string>() }
    homeTarget.names?.add(CLAUDE_JSON)
    targets.set(home, homeTarget)
    for (const [dir, t] of targets) {
      if (!existsSync(dir)) continue
      try {
        const w = watch(dir, { recursive: t.recursive, persistent: false }, (_event, name) => {
          if (t.names && (!name || !t.names.has(String(name)))) return
          this.onWatch()
        })
        w.on('error', () => w.close())
        this.watchers.push(w)
      } catch (err) {
        this.log(`cannot watch ${dir} (${(err as Error).message}); the 15-minute sync covers it`)
      }
    }
  }

  private onWatch(): void {
    if (this.watchTimer) clearTimeout(this.watchTimer)
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null
      void this.syncAll('watch')
    }, WATCH_DEBOUNCE_MS)
    this.watchTimer.unref()
  }

  async syncAll(why: 'manual' | 'watch' | 'periodic' | 'link-up' = 'manual'): Promise<void> {
    await Promise.all(this.deps.peers.all().map((l) => this.syncWith(l.id, why)))
  }

  syncWith(environmentId: string, why: 'manual' | 'watch' | 'periodic' | 'link-up' = 'manual'): Promise<void> {
    if (!this.enabled()) return Promise.resolve()
    const running = this.syncing.get(environmentId)
    if (running) {
      // A change while a sync runs may have missed its manifest: one more run after it.
      if (why === 'watch') this.again.add(environmentId)
      return running
    }
    const run = this.runSync(environmentId, why).finally(() => {
      this.syncing.delete(environmentId)
      if (this.again.delete(environmentId)) void this.syncWith(environmentId, 'watch')
    })
    this.syncing.set(environmentId, run)
    return run
  }

  private async runSync(environmentId: string, why: string): Promise<void> {
    const link = this.deps.peers.get(environmentId)
    if (!link?.connected) return
    const home = this.home()
    const manifest = buildManifest(home, { rules: this.rules, cache: this.cache as HashCache })
    this.skipped = manifest.skipped.length
    const digest = sha256(JSON.stringify([manifest.entries, manifest.claudeJson ?? null]))
    // A watch event that changed nothing in the set (a write the set filters out) sends nothing.
    if (why === 'watch' && this.lastDigest.get(environmentId) === digest) return
    const generation = randomUUID()
    this.record(environmentId, { lastAttemptAt: this.now() })
    try {
      const answer = await link.request<HarnessManifestAnswer>(
        'harness.manifest',
        { from: this.deps.environmentId, home, generation, entries: manifest.entries, ...(manifest.claudeJson ? { claudeJson: manifest.claudeJson } : {}) },
        { timeoutMs: MANIFEST_TIMEOUT_MS }
      )
      const byPath = new Map(manifest.entries.map((e) => [e.relPath, e]))
      for (const relPath of answer.need) {
        const entry = byPath.get(relPath)
        if (!entry) throw new Error(`${link.env.name} asked for ${relPath}, which is not in the manifest`)
        const data = readFileSync(join(home, relPath))
        // Changed since the manifest: the watch sends a fresh one shortly.
        if (sha256(data) !== entry.sha256) throw new Error(`${relPath} changed during the sync`)
        const chunks = Math.max(1, Math.ceil(data.length / HARNESS_CHUNK_BYTES))
        for (let i = 0; i < chunks; i++) {
          const dataBase64 = data.subarray(i * HARNESS_CHUNK_BYTES, (i + 1) * HARNESS_CHUNK_BYTES).toString('base64')
          await link.request('harness.file', { generation, relPath, chunkIndex: i, chunks, dataBase64 }, { timeoutMs: CHUNK_TIMEOUT_MS })
        }
      }
      const done = await link.request<HarnessCommitAnswer>('harness.commit', { generation }, { timeoutMs: MANIFEST_TIMEOUT_MS })
      this.lastDigest.set(environmentId, digest)
      this.record(environmentId, { files: done.files, sets: setCounts(manifest.entries, this.rules), syncedAt: this.now(), error: null })
      if (done.written || done.deleted || done.claudeJson || answer.refused)
        this.log(`${link.env.name}: ${done.files} files, ${done.written} written, ${done.deleted} deleted${done.claudeJson ? ', ~/.claude.json keys merged' : ''}${answer.refused ? `, ${answer.refused} refused there` : ''} (${why})`)
    } catch (err) {
      const message = (err as Error).message
      this.lastDigest.delete(environmentId)
      this.record(environmentId, { error: message })
      this.log(`${link.env.name}: sync failed (${message})`)
    }
  }

  // ── the receiver ───────────────────────────────────────────────────────

  private get syncDir(): string {
    return join(this.deps.dataDir, 'harness-sync')
  }

  private loadLedger(): Ledger {
    try {
      const parsed = JSON.parse(readFileSync(join(this.syncDir, 'ledger.json'), 'utf8')) as Ledger
      if (parsed.version === LEDGER_VERSION && parsed.files) return { ...parsed, claudeKeys: parsed.claudeKeys ?? [], from: parsed.from ?? null }
    } catch {
      /* none yet */
    }
    return { version: LEDGER_VERSION, from: null, files: {}, claudeKeys: [] }
  }

  private saveLedger(ledger: Ledger): void {
    mkdirSync(this.syncDir, { recursive: true, mode: 0o700 })
    const path = join(this.syncDir, 'ledger.json')
    const tmp = `${path}.${randomBytes(4).toString('hex')}`
    writeFileSync(tmp, JSON.stringify(ledger), { mode: 0o600 })
    renameSync(tmp, path)
  }

  /** The map a sender's files land under: the setting (or the shipped map), plus its home, IdeaProjects and Desktop/Websites. */
  translationFor(senderHome: string): HistoryMapping {
    const base = this.pathMap()
    const home = stripSlash(this.home())
    const from = stripSlash(senderHome)
    const prefixes = { ...base.prefixes }
    const add = (src: string, dst: string): void => {
      if (src !== dst && !(src in prefixes) && !(src in base.roots)) prefixes[src] = dst
    }
    const work = this.deps.workRoot?.()
    // On a host whose workspaces live in the home dir itself, IdeaProjects/X stays IdeaProjects/X.
    if (work && stripSlash(work) !== home) {
      add(`${from}/IdeaProjects`, stripSlash(work))
      add(`${from}/Desktop/Websites`, stripSlash(work))
    }
    add(from, home)
    return { roots: { ...base.roots }, prefixes }
  }

  /** The destination of a relPath, or why it may not land: outside the set, a secret, or a real parent outside the real rule root. */
  private destination(relPath: string): { path: string; root: string } | { refused: string } {
    const rule = ruleFor(relPath, this.rules)
    if (!rule) return { refused: isSecretPath(relPath) ? 'a secret' : 'outside the set' }
    const home = this.home()
    const root = join(home, ruleRoot(rule))
    const path = join(home, relPath)
    if (!within(realSpelling(dirname(path)), realSpelling(root))) return { refused: 'a symlink out of the set' }
    return { path, root }
  }

  private serial<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => {})
    return run
  }

  handleManifest(params: HarnessManifestParams): Promise<HarnessManifestAnswer> {
    return this.serial(() => this.manifest(params))
  }

  private manifest(params: HarnessManifestParams): HarnessManifestAnswer {
    if (!params.home.startsWith('/')) throw new Error('harness.manifest: home must be absolute')
    this.discardGeneration()
    const ledger = this.loadLedger()
    const tx = sha256(JSON.stringify(this.translationFor(params.home)))
    const entries = new Map<string, HarnessEntry>()
    let refused = 0
    for (const entry of params.entries) {
      const dest = this.destination(entry.relPath)
      if ('refused' in dest) {
        refused++
        this.log(`refused ${JSON.stringify(entry.relPath)} from ${params.from}: ${dest.refused}`)
        continue
      }
      entries.set(entry.relPath, entry)
    }
    const need: string[] = []
    for (const [relPath, entry] of entries) {
      const had = ledger.files[relPath]
      const wantTx = translatable(relPath, entry.size) ? tx : ''
      if (!had || had.src !== entry.sha256 || had.mode !== (entry.mode & 0o777) || (wantTx && had.tx !== wantTx) || !this.intact(relPath, had)) need.push(relPath)
    }
    const remove = Object.keys(ledger.files).filter((relPath) => !entries.has(relPath))
    const dir = join(this.syncDir, 'staging', params.generation.replace(/[^A-Za-z0-9-]/g, '_'))
    this.generation = { id: params.generation, from: params.from, home: params.home, entries, need: new Set(need), remove, claudeJson: params.claudeJson, dir, chunks: new Map() }
    return { need, remove, refused }
  }

  /** Whether the file the ledger says landed is still on disk as it landed (size and mtime, else its hash). */
  private intact(relPath: string, had: LedgerEntry): boolean {
    let st
    try {
      st = lstatSync(join(this.home(), relPath))
    } catch {
      return false
    }
    if (!st.isFile()) return false
    if (st.size === had.size && Math.floor(st.mtimeMs) === Math.floor(had.mtimeMs)) return true
    try {
      return sha256(readFileSync(join(this.home(), relPath))) === had.landed
    } catch {
      return false
    }
  }

  private discardGeneration(): void {
    rmSync(join(this.syncDir, 'staging'), { recursive: true, force: true })
    this.generation = null
  }

  handleFile(params: HarnessFileParams): { received: number } {
    const g = this.generation
    if (!g || g.id !== params.generation) throw new Error('harness.file: not the current generation')
    if (!g.need.has(params.relPath)) throw new Error('harness.file: not a file this generation needs')
    if (params.chunkIndex >= params.chunks) throw new Error('harness.file: chunk index out of range')
    const state = g.chunks.get(params.relPath) ?? { total: params.chunks, got: new Set<number>() }
    if (state.total !== params.chunks) throw new Error('harness.file: chunk count changed')
    const data = Buffer.from(params.dataBase64, 'base64')
    const fileDir = join(g.dir, sha256(params.relPath))
    mkdirSync(fileDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(fileDir, String(params.chunkIndex)), data, { mode: 0o600 })
    state.got.add(params.chunkIndex)
    g.chunks.set(params.relPath, state)
    return { received: state.got.size }
  }

  handleCommit(params: { generation: string }): Promise<HarnessCommitAnswer> {
    return this.serial(() => this.commit(params.generation))
  }

  private commit(generation: string): HarnessCommitAnswer {
    const g = this.generation
    if (!g || g.id !== generation) throw new Error('harness.commit: not the current generation')
    try {
      // Every file whole and matching its hash before anything is swapped in.
      const ready = new Map<string, Buffer>()
      for (const relPath of g.need) {
        const state = g.chunks.get(relPath)
        if (!state || state.got.size !== state.total) throw new Error(`harness.commit: ${relPath} is incomplete`)
        const fileDir = join(g.dir, sha256(relPath))
        const data = Buffer.concat(Array.from({ length: state.total }, (_, i) => readFileSync(join(fileDir, String(i)))))
        const entry = g.entries.get(relPath)!
        if (data.length !== entry.size || sha256(data) !== entry.sha256) throw new Error(`harness.commit: ${relPath} does not match its hash`)
        ready.set(relPath, data)
      }
      const ledger = this.loadLedger()
      const mapping = this.translationFor(g.home)
      const tx = sha256(JSON.stringify(mapping))
      const remap = remapper(mapping)
      let written = 0
      const failed: string[] = []
      for (const [relPath, data] of ready) {
        const entry = g.entries.get(relPath)!
        const dest = this.destination(relPath)
        if ('refused' in dest) {
          this.log(`refused ${JSON.stringify(relPath)} from ${g.from}: ${dest.refused}`)
          continue
        }
        if (isMachO(data)) {
          this.log(`refused ${JSON.stringify(relPath)} from ${g.from}: a macOS binary`)
          continue
        }
        let out = data
        let usedTx = ''
        if (translatable(relPath, data.length)) {
          const text = decodeText(data)
          if (text !== null) {
            out = Buffer.from(remap.text(text), 'utf8')
            usedTx = tx
          }
        }
        if (relPath === '.claude/settings.json') {
          const stripped = stripHostBoundEnv(out.toString('utf8'))
          if (stripped.dropped.length) {
            out = Buffer.from(stripped.text, 'utf8')
            this.log(`settings.json: dropped env ${stripped.dropped.join(', ')} (a loopback address on the sender means nothing here)`)
          }
        }
        if (relPath === '.codex/config.toml') {
          const stripped = stripHostBoundToml(out.toString('utf8'))
          if (stripped.dropped.length) {
            out = Buffer.from(stripped.text, 'utf8')
            this.log(`config.toml: dropped ${stripped.dropped.join(', ')} (a loopback address on the sender means nothing here)`)
          }
        }
        const mode = entry.mode & 0o777
        const tmp = join(dirname(dest.path), `.${basename(dest.path)}.tc-sync-${randomBytes(4).toString('hex')}`)
        try {
          mkdirSync(dirname(dest.path), { recursive: true, mode: 0o755 })
          writeFileSync(tmp, out, { mode })
          chmodSync(tmp, mode)
          const mtime = new Date(entry.mtime)
          utimesSync(tmp, mtime, mtime)
          renameSync(tmp, dest.path)
        } catch (err) {
          // One file in the way (a dir where the sender has a file) does not hold the rest back.
          rmSync(tmp, { force: true })
          failed.push(relPath)
          this.log(`could not land ${JSON.stringify(relPath)} (${(err as Error).message})`)
          continue
        }
        const st = statSync(dest.path)
        ledger.files[relPath] = { src: entry.sha256, landed: sha256(out), size: st.size, mtimeMs: st.mtimeMs, mode, tx: usedTx }
        written++
        if (relPath === '.claude/settings.json') this.reportHooks(out.toString('utf8'))
      }
      let deleted = 0
      for (const relPath of g.remove) {
        delete ledger.files[relPath]
        const dest = this.destination(relPath)
        if ('refused' in dest) continue
        try {
          const st = lstatSync(dest.path)
          if (!st.isFile() && !st.isSymbolicLink()) continue
          unlinkSync(dest.path)
          deleted++
          pruneEmptyDirs(dirname(dest.path), dest.root, rmdirSync)
        } catch {
          /* already gone */
        }
      }
      const claudeJson = g.claudeJson ? this.mergeClaudeJson(g.claudeJson, remap.text, ledger) : false
      ledger.from = g.from
      this.saveLedger(ledger)
      if (failed.length) throw new Error(`harness.commit: ${failed.length} file(s) did not land here, first ${failed[0]}`)
      if (written || deleted || claudeJson) this.log(`from ${g.from}: ${written} written, ${deleted} deleted${claudeJson ? ', ~/.claude.json keys merged' : ''}`)
      return { files: g.entries.size, written, deleted, claudeJson }
    } finally {
      this.discardGeneration()
    }
  }

  /** The two keys into this host's own ~/.claude.json (paths translated), and a key the sender dropped out of it; every other key stays as it is. */
  private mergeClaudeJson(keys: HarnessClaudeJson, translate: (text: string) => string, ledger: Ledger): boolean {
    const path = join(this.home(), CLAUDE_JSON)
    let current: Record<string, unknown> = {}
    let raw: string | null = null
    if (existsSync(path)) {
      try {
        raw = readFileSync(path, 'utf8')
        const parsed = JSON.parse(raw) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
        current = parsed as Record<string, unknown>
      } catch (err) {
        this.log(`~/.claude.json here is not readable JSON (${(err as Error).message}); its keys are left alone`)
        return false
      }
    }
    const next = { ...current }
    const wrote: string[] = []
    for (const key of HARNESS_CLAUDE_KEYS) {
      if (keys[key] !== undefined) {
        next[key] = JSON.parse(translate(JSON.stringify(keys[key])))
        wrote.push(key)
      } else if (ledger.claudeKeys.includes(key)) delete next[key]
    }
    ledger.claudeKeys = wrote
    if (JSON.stringify(next) === JSON.stringify(current) && raw !== null) return false
    const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600
    const tmp = `${path}.tc-sync-${randomBytes(4).toString('hex')}`
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode })
    renameSync(tmp, path)
    return true
  }

  private reportHooks(settingsText: string): void {
    const missing = missingHookExecutables(settingsText, { PATH: this.deps.pathEnv?.() ?? process.env.PATH, home: this.home() })
    this.log(missing.length ? `settings.json landed; hook commands not on this host's PATH: ${missing.join(', ')}` : 'settings.json landed')
  }

  close(): void {
    this.closed = true
    this.stopWatching()
  }
}

/** The `harness.*` requests, for the server's dispatch. */
export async function handleHarness(req: ClientRequest, sync: HarnessSync): Promise<{ handled: true; result: unknown } | { handled: false }> {
  switch (req.method) {
    case 'harness.manifest':
      return { handled: true, result: await sync.handleManifest(req.params) }
    case 'harness.file':
      return { handled: true, result: sync.handleFile(req.params) }
    case 'harness.commit':
      return { handled: true, result: await sync.handleCommit(req.params) }
    case 'harness.status':
      return { handled: true, result: sync.status() }
    case 'harness.sync':
      if (req.params?.environmentId) await sync.syncWith(req.params.environmentId, 'manual')
      else await sync.syncAll('manual')
      return { handled: true, result: sync.status() }
    case 'harness.settings.set':
      sync.setSettings(req.params)
      return { handled: true, result: sync.status() }
    default:
      return { handled: false }
  }
}
