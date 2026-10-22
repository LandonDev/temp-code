import { randomBytes } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { lstat, open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { ClientRequest, ServerPush } from '@shared/contract'
import {
  heldLine,
  MAC_APPROVAL_WAIT_MS,
  MAC_BRIDGE_DEFAULT_MAX_RUNNING,
  MAC_BRIDGE_DEFAULT_MAX_THREADS,
  MAC_BRIDGE_MAX_RUNNING_CAP,
  MAC_BRIDGE_MAX_THREADS_CAP,
  MAC_BRIDGE_OFFER,
  MAC_FETCH_MAX_BYTES,
  MAC_LIST_MAX_ENTRIES,
  MAC_READ_DEFAULT_BYTES,
  MAC_RUN_DEFAULT_TIMEOUT_MS,
  MacBridgePolicySchema,
  MacFetchFileArgsSchema,
  MacListDirArgsSchema,
  MacReadFileArgsSchema,
  MacRunArgsSchema,
  type MacBridgeHeld,
  type MacBridgeHostPolicy,
  type MacBridgeLoad,
  type MacBridgeOutcome,
  type MacBridgeThreadAdmission,
  type MacBridgePolicy,
  type MacBridgePush,
  type MacBridgeRequest,
  type MacCallParams,
  type MacDirEntry,
  type MacFetchFileWire,
  type MacListDirResult,
  type MacReadFileResult,
  type MacRunResult
} from '@shared/contract-macbridge'
import type { MacDecideRemember } from '@shared/contract-macbridge-rules'
import { insideRoots, realSpelling } from './fence'
import { isSecretPath } from './harnessSet'
import { MacBridgeRuleBook, readRemembers, runOffer, runRememberKind } from './macBridgeRules'
import { runMacCommand, type RunningCommand } from './macRunner'
import { servePeerCall, type LinkRequest } from './peerCalls'
import { serveMacWrite, writeFoldersOf } from './macBridgeWrite'
import type { MacWriteFileResult } from '@shared/contract-macbridge'
import { threadRunsUnattended, type MacCallThread } from '@shared/contract-macbridge'
import type { MacCancelArgs, MacCancelResult, MacHeldArgs } from '@shared/contract-macbridge'
import { isMacJobPeerMethod, isMacPausePeerMethod, type MacPeerMethod } from '@shared/contract-macjobs'
import { isCrossHostPeerMethod } from '@shared/contract-crosshost'
import { isHostDevicesPeerMethod } from '@shared/contract-hostdevices'
import { isPublishPeerMethod } from '@shared/contract-publish'
import { MacJobs, type JobSpawner } from './macJobs'
import { MacLoadGuard, type HoldEnd, type LoadSample } from './macLoadGuard'

/**
 * The Mac side of the Mac bridge (docs/box.md "The Mac bridge: what a box
 * thread may touch on the Mac"). A box thread's mac.* call arrives here as a
 * `peer.call` push on the link this Mac's main process holds to that box,
 * and the Mac decides everything:
 *
 *  - Per box, a policy (`macBridge.policy.<envId>`): off (the default) |
 *    read | read+run | full, and shared folders (`macBridge.shared.<envId>`):
 *    absolute dirs, never '/', never the home directory or one above it.
 *  - Reads and listings inside this Mac's app-managed roots or a shared
 *    folder go through without a prompt; any other path asks the person at
 *    the Mac, once per request, with "allow this folder for this thread".
 *    Under full, every other path goes through as well, except the keys and
 *    credentials macDenied names and the directories above home (`/`,
 *    `/Users`), which still ask every time.
 *  - The decision comes before any read: a path outside what the policy
 *    admits asks (or, with the bridge off, is refused) whether or not it
 *    exists, so the box learns nothing of it until the person allows.
 *  - Every command asks, showing argv and cwd, with a remember choice (exact,
 *    folder, program, thread; macBridgeRules.ts, which also holds the
 *    always-ask floor). It runs through the login shell (macRunner.ts).
 *  - A thread in full access on its box (permission `auto`, sent with every
 *    call) is never prompted: whatever the policy admits for the host goes
 *    through as if remembered, reads, writes, commands and jobs alike. The
 *    policy still rules: off refuses, read refuses commands.
 *  - A command admitted without a prompt (remembered, or such a thread) is
 *    `quiet` unless the host's "Show running commands"
 *    (`macBridge.showRunning.<envId>`, off by default under full, on
 *    otherwise) is on: the request still exists, with Stop, but carries
 *    `quiet: true` and the renderer draws no card for it (runPresentation).
 *  - The load guard (macLoadGuard.ts) sits between the decision and the
 *    spawn of every command and job: at most `macBridge.maxRunning.<envId>`
 *    (default 4) of a host's run at once, and while the Mac's one-minute
 *    load is over `macBridge.loadLimit` (default 2 × cores, back under at
 *    1.5 ×) none starts. A call it holds is `held`, not refused: it waits
 *    its turn in order within the call's own deadline, shows its place on
 *    the Mac ("Waiting for the Mac · load 12.3 of 8 · 3rd in line") and can
 *    be stopped there. Reads, listings, fetches and writes are never held.
 *    `macBridge.maxThreads.<envId>` (default 2) caps the Mac-local threads
 *    a host starts here; crossHostThreads.ts asks `admitThread` first.
 *
 *  - A thread that pauses or stops on its box sends `mac.cancel` naming the
 *    calls it had out here: each gets what the Stop button sends (a waiting
 *    card is denied, a running command killed) and its interactive jobs end;
 *    the box has already answered those calls, so the late reply is dropped
 *    there. While paused, the box holds the thread's commands, jobs and
 *    writes and lists them here with `mac.held`: each is a `paused` row
 *    (status 'paused', id `mb_held_<id>`) with nothing to stop, gone when the
 *    box releases or refuses it. A read from a paused thread arrives marked
 *    `paused` and is refused where it would have asked.
 *
 * The prompt is a `macBridge.request` push to this Mac's own local sockets
 * (its renderer), answered by `macBridge.decide`, which is local-only: no
 * key, no phone and no box can ever answer one. Remember rules live in
 * memory, per (box, thread), and end with the app. One log line per call
 * names the host, thread, method and decision, never a file's contents.
 */

export const POLICY_PREFIX = 'macBridge.policy.'
export const SHARED_PREFIX = 'macBridge.shared.'
/** 'on' | 'off', or unset for the policy's default (off under full, on otherwise). */
export const SHOW_RUNNING_PREFIX = 'macBridge.showRunning.'
/** The load guard's caps per host (an integer, else the defaults) and the Mac-wide load limit (a number, else 2 × cores). */
export const MAX_RUNNING_PREFIX = 'macBridge.maxRunning.'
export const MAX_THREADS_PREFIX = 'macBridge.maxThreads.'
export const LOAD_LIMIT_KEY = 'macBridge.loadLimit'
/** A request asks no longer than the box will wait for it, less this margin for the reply to travel. */
const REPLY_MARGIN_MS = 3_000

export interface MacBridgeDeps {
  /** This Mac's own environment id: what it registers as on a host. */
  environmentId: string
  store: {
    getSetting(key: string): string | null
    setSetting(key: string, value: string | null): void
  }
  /** This Mac's own app-managed roots (index.ts managedRoots). */
  managedRoots: () => string[]
  /** The saved hosts (remote.environments), by id and name. */
  environments: () => { id: string; name: string }[]
  /** How to send on the link to a host, while it is up. */
  link: (envId: string) => LinkRequest | null
  home?: string
  shell?: string
  run?: typeof runMacCommand
  log?: (line: string) => void
  /** Interactive jobs' process (macJobs.ts): node-pty by default. */
  jobSpawner?: JobSpawner
  /** Offers besides the bridge's that ride the same peer.register (the threads offer, remote/crossHostThreads.ts). */
  offers?: () => string[]
  /** The load watch's sampler and cadence (macLoadGuard.ts): os.loadavg every 15 s by default; intervalMs 0 never ticks (tests). */
  load?: { sample?: () => LoadSample; intervalMs?: number }
  /** Mac-local threads a host started here that are live now (crossHostThreads.ts); counts toward `macBridge.maxThreads.<envId>`. */
  liveThreads?: (envId: string) => number
}

// ── the policy, pure ─────────────────────────────────────────────────

/** home, and every directory above it: sharing one of these shares all of home. */
function coversHome(dir: string, home: string): boolean {
  return dir === sep || dir === home || home.startsWith(dir.endsWith(sep) ? dir : dir + sep)
}

/** A folder a box may read without asking: absolute, a directory, by its real path; never '/', home, or above home. */
export function validateSharedFolder(path: string, home: string = homedir()): string {
  if (!isAbsolute(path)) throw new Error(`a shared folder must be an absolute path: ${path}`)
  const real = realSpelling(resolve(path))
  const realHome = realSpelling(home)
  if (coversHome(real, realHome))
    throw new Error(`refused: ${path} would share the whole home directory or disk`)
  if (!existsSync(real) || !statSync(real).isDirectory()) throw new Error(`not a folder: ${path}`)
  return real
}

/** The folder "allow this folder for this thread" admits for a path, or null where that would be home or wider. */
export function rememberFolder(
  real: string,
  isDir: boolean,
  home: string = homedir()
): string | null {
  const folder = isDir ? real : dirname(real)
  return coversHome(folder, realSpelling(home)) ? null : folder
}

/**
 * Keys and credentials full access never reads without asking, relative to
 * home: whole folders, then single files. Besides these, any file the harness
 * sync's secret rule names (harnessSet.ts isSecretPath: *.pem, *.key,
 * auth.json, .credentials.json, …) asks wherever it lives.
 */
export const FULL_DENY_DIRS = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.config/gh',
  '.aliax',
  'Library/Keychains',
  'Library/Application Support/TempCode',
  'Library/Application Support/temp-code'
] as const
export const FULL_DENY_FILES = ['.claude/.credentials.json', '.codex/auth.json'] as const

/** Strict containment on a segment boundary, case-folded (macOS volumes are case-insensitive by default). */
function underFolded(path: string, root: string): boolean {
  const p = path.toLowerCase()
  const r = root.toLowerCase().replace(/\/+$/, '')
  return p === r || p.startsWith(r + sep)
}

/**
 * Whether full access must still ask for a real path: a deny-list folder or
 * file under home (by its literal and its real spelling, so a symlinked
 * ~/.aliax is caught at its target too), a secret by name anywhere, or a
 * directory above home ('/', '/Users'), which would show every account's
 * folder. Home itself does not ask.
 */
export function macDenied(real: string, home: string): boolean {
  const homes = [...new Set([home, realSpelling(home)])]
  for (const h of homes) {
    if (real !== h && coversHome(real, h)) return true
    for (const rel of [...FULL_DENY_DIRS, ...FULL_DENY_FILES]) {
      const literal = join(h, rel)
      if (underFolded(real, literal) || underFolded(real, realSpelling(literal))) return true
    }
  }
  const base = basename(real)
  return isSecretPath(base) || isSecretPath(base.toLowerCase())
}

export type ReadVerdict =
  { allow: true; why: 'managed' | 'shared' | 'remembered' | 'full' } | { allow: false }

/** Whether a read goes through without asking. `full` is the home whose keys still ask, when the policy is full. */
export function readVerdict(
  real: string,
  rules: {
    managed: readonly string[]
    shared: readonly string[]
    remembered: readonly string[]
    full?: { home: string } | null
  }
): ReadVerdict {
  if (rules.managed.length && insideRoots(real, rules.managed))
    return { allow: true, why: 'managed' }
  if (rules.shared.length && insideRoots(real, rules.shared)) return { allow: true, why: 'shared' }
  if (rules.remembered.length && insideRoots(real, rules.remembered))
    return { allow: true, why: 'remembered' }
  if (rules.full && !macDenied(real, rules.full.home)) return { allow: true, why: 'full' }
  return { allow: false }
}

/**
 * How a command (or job) reaches the Mac's screen. One that nothing admits
 * prompts, and a prompt always shows. One a rule remembers, or one from a
 * thread in full access on its box, starts at once; it shows as a running
 * card only while the host's "Show running commands" is on, else it is
 * quiet: in the pending list with Stop, no card. What is admitted never
 * changes here: this is presentation only.
 */
export type RunPresentation =
  | { prompt: true }
  | { prompt: false; why: 'remembered' | 'full access'; quiet: boolean }

export function runPresentation(opts: {
  remembered: boolean
  unattended: boolean
  showRunning: boolean
}): RunPresentation {
  if (!opts.remembered && !opts.unattended) return { prompt: true }
  return {
    prompt: false,
    why: opts.remembered ? 'remembered' : 'full access',
    quiet: !opts.showRunning
  }
}

/** The default of "Show running commands" for a policy: off under full, on otherwise. */
export function showRunningDefault(policy: MacBridgePolicy): boolean {
  return policy !== 'full'
}

/** The key "allow this exact command" remembers: argv or the command string, and the cwd. */
export const commandKey = (spec: { argv?: string[]; command?: string; cwd: string }): string =>
  JSON.stringify([spec.argv ?? null, spec.command ?? null, spec.cwd])

/**
 * A box path for this Mac, by its real spelling: absolute, or `~` / `~/…`
 * for this Mac's home (the thread's tool text names it). `~user` and
 * relative paths are refused. Resolving the spelling reads no file and its
 * result never reaches the box before the policy has decided.
 */
export function macPath(path: string, home: string = homedir()): string {
  const expanded = path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path
  if (!isAbsolute(expanded))
    throw new Error(`paths on the Mac must be absolute or start with ~/: ${path}`)
  return realSpelling(resolve(expanded))
}

/** utf8 when the bytes are text (a cut multi-byte tail is trimmed), else null. */
export function asText(buf: Buffer): string | null {
  if (buf.includes(0)) return null
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (let trim = 0; trim <= 3 && trim <= buf.length; trim++) {
    try {
      return decoder.decode(buf.subarray(0, buf.length - trim))
    } catch {
      /* try one byte shorter: a character cut at the end */
    }
  }
  return null
}

// ── the bridge ───────────────────────────────────────────────────────

interface Pending {
  request: MacBridgeRequest
  decide: (allow: boolean, remember: Remember) => void
  stop?: () => void
  timer: NodeJS.Timeout
  /** The box's `peer.call` id this request serves: what a `mac.cancel` names. */
  callId?: string
}

/** The Mac's answer to a read a paused thread sent that would have asked (macPause.ts says the same for a held call). */
export const REFUSED_PAUSED = 'refused: the thread is paused'
/** The row id of a call a paused box thread holds (mac.held). */
export const HELD_ROW_PREFIX = 'mb_held_'

/** A decide's remember (contract-macbridge-rules.ts). */
type Remember = MacDecideRemember

export class MacBridge {
  private readonly pendingById = new Map<string, Pending>()
  /** Calls paused box threads hold (mac.held), as `paused` rows, by row id. */
  private readonly heldRows = new Map<string, MacBridgeRequest>()
  private readonly listeners = new Set<(push: MacBridgePush) => void>()
  /** Remembered approvals per (host, thread), in memory only (macBridgeRules.ts). */
  readonly rules: MacBridgeRuleBook
  private readonly registered = new Set<string>()
  private readonly home: string
  private readonly log: (line: string) => void
  /** The caps and the load watch (macLoadGuard.ts); every held call's standing lands on its request. */
  readonly guard: MacLoadGuard

  constructor(private readonly deps: MacBridgeDeps) {
    this.home = deps.home ?? homedir()
    this.rules = new MacBridgeRuleBook(this.home)
    this.log = deps.log ?? ((line) => console.log(`[mac-bridge] ${line}`))
    this.guard = new MacLoadGuard({
      maxRunning: (envId) => this.maxRunningOf(envId),
      loadLimit: () => this.loadLimitPinned(),
      ...(deps.load?.sample ? { sample: deps.load.sample } : {}),
      ...(deps.load?.intervalMs !== undefined ? { intervalMs: deps.load.intervalMs } : {}),
      onChange: (id, held) => this.standingChanged(id, held),
      log: (line) => this.log(`load guard: ${line}`)
    })
  }

  // ── settings ───────────────────────────────────────────────────────

  policyOf(envId: string): MacBridgePolicy {
    const parsed = MacBridgePolicySchema.safeParse(
      this.deps.store.getSetting(`${POLICY_PREFIX}${envId}`)
    )
    return parsed.success ? parsed.data : 'off'
  }

  setPolicy(envId: string, policy: MacBridgePolicy): MacBridgeHostPolicy[] {
    this.knownHost(envId)
    this.deps.store.setSetting(`${POLICY_PREFIX}${envId}`, policy === 'off' ? null : policy)
    if (policy === 'off' || policy === 'read') this.jobsInstance?.endHost(envId)
    this.log(`${this.nameOf(envId)} (${envId}): policy ${policy}`)
    return this.hosts()
  }

  sharedOf(envId: string): string[] {
    try {
      const list = JSON.parse(
        this.deps.store.getSetting(`${SHARED_PREFIX}${envId}`) ?? '[]'
      ) as unknown
      return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : []
    } catch {
      return []
    }
  }

  /** Replace a host's shared folders; one bad folder refuses the whole list. */
  setShared(envId: string, folders: string[]): MacBridgeHostPolicy[] {
    this.knownHost(envId)
    const clean = [...new Set(folders.map((f) => validateSharedFolder(f, this.home)))]
    this.deps.store.setSetting(
      `${SHARED_PREFIX}${envId}`,
      clean.length ? JSON.stringify(clean) : null
    )
    this.log(`${this.nameOf(envId)} (${envId}): ${clean.length} shared folder(s)`)
    return this.hosts()
  }

  /** Whether a command admitted without a prompt shows as a running card: pinned, else the policy's default. */
  showRunningOf(envId: string): boolean {
    const raw = this.deps.store.getSetting(`${SHOW_RUNNING_PREFIX}${envId}`)
    if (raw === 'on') return true
    if (raw === 'off') return false
    return showRunningDefault(this.policyOf(envId))
  }

  setShowRunning(envId: string, show: boolean): MacBridgeHostPolicy[] {
    this.knownHost(envId)
    this.deps.store.setSetting(`${SHOW_RUNNING_PREFIX}${envId}`, show ? 'on' : 'off')
    this.log(`${this.nameOf(envId)} (${envId}): show running commands ${show ? 'on' : 'off'}`)
    return this.hosts()
  }

  // ── the load guard's settings ───────────────────────────────────────

  private intSetting(key: string, fallback: number, min: number, max: number): number {
    const raw = this.deps.store.getSetting(key)
    const n = raw === null ? NaN : Number(raw)
    return Number.isInteger(n) && n >= min && n <= max ? n : fallback
  }

  /** Concurrent commands and jobs this host may run on the Mac. */
  maxRunningOf(envId: string): number {
    return this.intSetting(
      `${MAX_RUNNING_PREFIX}${envId}`,
      MAC_BRIDGE_DEFAULT_MAX_RUNNING,
      1,
      MAC_BRIDGE_MAX_RUNNING_CAP
    )
  }

  /** Concurrent Mac-local threads this host may have started here. */
  maxThreadsOf(envId: string): number {
    return this.intSetting(
      `${MAX_THREADS_PREFIX}${envId}`,
      MAC_BRIDGE_DEFAULT_MAX_THREADS,
      0,
      MAC_BRIDGE_MAX_THREADS_CAP
    )
  }

  /** A host's caps; null puts one back to its default. A raised cap releases held calls at once. */
  setLimits(
    envId: string,
    limits: { maxRunning?: number | null; maxThreads?: number | null }
  ): MacBridgeHostPolicy[] {
    this.knownHost(envId)
    if (limits.maxRunning !== undefined) {
      const n = limits.maxRunning
      if (n !== null && (!Number.isInteger(n) || n < 1 || n > MAC_BRIDGE_MAX_RUNNING_CAP))
        throw new Error(`running: a whole number from 1 to ${MAC_BRIDGE_MAX_RUNNING_CAP}`)
      this.deps.store.setSetting(`${MAX_RUNNING_PREFIX}${envId}`, n === null ? null : String(n))
    }
    if (limits.maxThreads !== undefined) {
      const n = limits.maxThreads
      if (n !== null && (!Number.isInteger(n) || n < 0 || n > MAC_BRIDGE_MAX_THREADS_CAP))
        throw new Error(`threads: a whole number from 0 to ${MAC_BRIDGE_MAX_THREADS_CAP}`)
      this.deps.store.setSetting(`${MAX_THREADS_PREFIX}${envId}`, n === null ? null : String(n))
    }
    this.log(
      `${this.nameOf(envId)} (${envId}): caps running ${this.maxRunningOf(envId)}, threads ${this.maxThreadsOf(envId)}`
    )
    this.guard.reconsider()
    return this.hosts()
  }

  /** `macBridge.loadLimit` when set by hand, else null (the guard uses 2 × cores). */
  loadLimitPinned(): number | null {
    const raw = this.deps.store.getSetting(LOAD_LIMIT_KEY)
    const n = raw === null ? NaN : Number(raw)
    return Number.isFinite(n) && n > 0 ? n : null
  }

  setLoadLimit(limit: number | null): MacBridgeLoad {
    if (limit !== null && (!Number.isFinite(limit) || limit <= 0))
      throw new Error('the load limit is a number above 0')
    this.deps.store.setSetting(LOAD_LIMIT_KEY, limit === null ? null : String(limit))
    this.log(`load limit ${limit === null ? 'follows the cores' : limit}`)
    this.guard.reconsider()
    return this.guard.status()
  }

  loadStatus(): MacBridgeLoad {
    return this.guard.status()
  }

  /**
   * Whether a host may start another Mac-local thread here now (docs/box.md
   * "Starting a thread on the Mac from the box"): crossHostThreads.ts asks
   * before every `thread.start` and `thread.spawn`. A refusal names the cap
   * and where to raise it; nothing is queued, the box thread tries again.
   */
  admitThread(envId: string): MacBridgeThreadAdmission {
    const live = this.deps.liveThreads?.(envId) ?? 0
    const max = this.maxThreadsOf(envId)
    if (live < max) return { ok: true, live, max }
    return {
      ok: false,
      live,
      max,
      reason:
        max === 0
          ? `the Mac takes no threads from this host (threads 0 in the Mac's Settings → Remote access → Mac bridge)`
          : `the Mac already runs ${live} ${live === 1 ? 'thread' : 'threads'} from this host, its cap of ${max}: wait for one to finish, or raise "threads" in the Mac's Settings → Remote access → Mac bridge`
    }
  }

  hosts(): MacBridgeHostPolicy[] {
    return this.deps.environments().map((e) => ({
      environmentId: e.id,
      name: e.name,
      policy: this.policyOf(e.id),
      shared: this.sharedOf(e.id),
      showRunning: this.showRunningOf(e.id),
      registered: this.registered.has(e.id),
      maxRunning: this.maxRunningOf(e.id),
      maxThreads: this.maxThreadsOf(e.id),
      running: this.guard.runningCount(e.id),
      held: this.guard.heldCount(e.id),
      threads: this.deps.liveThreads?.(e.id) ?? 0
    }))
  }

  private nameOf(envId: string): string {
    return this.deps.environments().find((e) => e.id === envId)?.name ?? envId
  }

  private knownHost(envId: string): void {
    if (!this.deps.environments().some((e) => e.id === envId))
      throw new Error(`unknown host: ${envId}`)
  }

  // ── the link ───────────────────────────────────────────────────────

  /** The link to a host opened: offer the bridge on it. */
  async linkUp(envId: string): Promise<void> {
    const request = this.deps.link(envId)
    if (!request) return
    try {
      await request('peer.register', {
        from: this.deps.environmentId,
        offers: [MAC_BRIDGE_OFFER, ...(this.deps.offers?.() ?? [])],
        home: this.home
      })
      this.registered.add(envId)
    } catch (err) {
      // An older host has no peer.register: no bridge there, nothing else changes.
      this.log(
        `${this.nameOf(envId)}: not registered (${err instanceof Error ? err.message : String(err)})`
      )
    }
  }

  linkDown(envId: string): void {
    this.registered.delete(envId)
    // What that box held is its own to list again when the link is back.
    for (const [id, row] of [...this.heldRows])
      if (row.environmentId === envId) this.dropHeldRow(id)
  }

  /** A push from a host: a peer.call is served and answered on the same link. */
  onPeerPush(envId: string, push: ServerPush): boolean {
    if (push.push !== 'peer.call') return false
    const request = this.deps.link(envId)
    if (!request) return true
    void servePeerCall(
      push,
      envId,
      (method, params, ctx) => this.handle(method, params, ctx),
      request,
      this.log
    )
    return true
  }

  // ── the renderer ───────────────────────────────────────────────────

  subscribe(listener: (push: MacBridgePush) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(push: MacBridgePush): void {
    for (const l of this.listeners) l(push)
  }

  pending(): MacBridgeRequest[] {
    return [...[...this.pendingById.values()].map((p) => p.request), ...this.heldRows.values()].sort(
      (a, b) => a.createdAt - b.createdAt
    )
  }

  decide(id: string, allow: boolean, remember: MacDecideRemember = false): { ok: true } {
    if (this.heldRows.has(id))
      throw new Error('that call waits on its host while the thread is paused: nothing runs here')
    const p = this.pendingById.get(id)
    if (!p) throw new Error('that request is no longer waiting')
    if (p.request.status === 'running') {
      if (allow) throw new Error('that command is already running')
      p.stop?.()
      return { ok: true }
    }
    if (p.request.status === 'held') {
      // Allowed already, waiting on the load guard: Stop takes it out of the line.
      if (allow) throw new Error('that command is already allowed and waiting its turn')
      this.guard.cancel(id)
      return { ok: true }
    }
    p.decide(allow, remember)
    return { ok: true }
  }

  /**
   * Hold an allowed command or job on the load guard until its turn (or the
   * call's deadline, `until`): the request turns `held` with its standing
   * for the renderer, and comes back as `admitted`, else the request is
   * finished and the reason thrown for the box thread's tool result.
   */
  private async hold(
    envId: string,
    id: string,
    until: number,
    line: (decision: string) => void
  ): Promise<void> {
    const gate = this.guard.acquire(envId, id, until)
    if (gate.admitted) return
    const p = this.pendingById.get(id)
    if (p) {
      p.request = { ...p.request, status: 'held', held: gate.held }
      this.emit({ push: 'macBridge.request', request: p.request })
    }
    line(`held (${heldLine(gate.held).slice('Waiting for the Mac · '.length).replace(' · ', ', ')})`)
    const end: HoldEnd = await gate.done
    if (end === 'admitted') {
      line('released')
      return
    }
    this.finish(id, end === 'expired' ? 'expired' : 'stopped')
    line(end === 'expired' ? 'held until the call ran out of time' : 'stopped while waiting')
    throw new Error(
      end === 'expired'
        ? 'the Mac stayed too busy: the call ran out of time while waiting its turn'
        : 'stopped at the Mac while waiting its turn'
    )
  }

  /** The guard moved a held call (its place, its reason, the load) or let it go: the row follows. */
  private standingChanged(id: string, held: MacBridgeHeld | null): void {
    const p = this.pendingById.get(id)
    if (!p || p.request.status !== 'held' || !held) return
    p.request = { ...p.request, held }
    this.emit({ push: 'macBridge.request', request: p.request })
  }

  /**
   * Ask the person at the Mac; resolves false on a denial or when the wait
   * runs out. A quiet request is one the caller decides at once and the
   * renderer never draws (runPresentation); it is still listed, with Stop.
   */
  private ask(
    shape: Omit<MacBridgeRequest, 'id' | 'createdAt' | 'expiresAt' | 'status' | 'quiet'>,
    until: number,
    quiet = false,
    callId?: string
  ): {
    id: string
    answer: Promise<{ allow: boolean; remember: Remember; outcome: MacBridgeOutcome }>
  } {
    const id = `mb_${randomBytes(9).toString('base64url')}`
    const now = Date.now()
    const request: MacBridgeRequest = {
      ...shape,
      id,
      createdAt: now,
      expiresAt: until,
      status: 'pending',
      ...(quiet ? { quiet: true } : {})
    }
    const answer = new Promise<{ allow: boolean; remember: Remember; outcome: MacBridgeOutcome }>(
      (resolve) => {
        let settled = false
        const timer = setTimeout(
          () => {
            if (settled) return
            settled = true
            this.finish(id, 'expired')
            resolve({ allow: false, remember: false, outcome: 'expired' })
          },
          Math.max(0, until - now)
        )
        timer.unref()
        this.pendingById.set(id, {
          request,
          timer,
          ...(callId ? { callId } : {}),
          decide: (allow, remember) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            if (!allow) this.finish(id, 'denied')
            resolve({ allow, remember, outcome: allow ? 'allowed' : 'denied' })
          }
        })
      }
    )
    this.emit({ push: 'macBridge.request', request })
    return { id, answer }
  }

  private finish(id: string, outcome: MacBridgeOutcome): void {
    this.guard.release(id)
    const p = this.pendingById.get(id)
    if (!p) return
    clearTimeout(p.timer)
    this.pendingById.delete(id)
    this.emit({ push: 'macBridge.resolved', id, outcome })
  }

  // ── pause and stop on the box (macPause.ts) ────────────────────────

  /**
   * mac.cancel: the thread paused or stopped. Every request of its that
   * serves one of the named calls gets what the Stop button sends (decide
   * false: a waiting card is denied, a running command killed), and with
   * `jobs` its interactive jobs end as stopped. Needs no policy: there is
   * nothing to admit, only things to end.
   */
  cancel(
    env: { id: string; name: string },
    thread: MacCallThread,
    args: MacCancelArgs,
    line: (decision: string) => void
  ): MacCancelResult {
    const wanted = new Set(Array.isArray(args.callIds) ? args.callIds : [])
    let cancelled = 0
    for (const [id, p] of [...this.pendingById]) {
      if (p.request.environmentId !== env.id || p.request.sessionId !== thread.id) continue
      if (!p.callId || !wanted.has(p.callId)) continue
      if (p.request.status === 'running') p.stop?.()
      else p.decide(false, false)
      cancelled++
      void id
    }
    const jobsEnded = args.jobs ? (this.jobsInstance?.stopThread(env.id, thread.id, line) ?? 0) : 0
    line(`${args.reason === 'paused' ? 'paused' : 'stopped'}: ${cancelled} cancelled, ${jobsEnded} job(s) ended`)
    return { cancelled, jobsEnded }
  }

  /**
   * mac.held: the whole set a paused thread holds on its box right now. Each
   * is a `paused` row here (nothing runs, nothing to stop); a row no longer
   * in the set goes.
   */
  held(
    env: { id: string; name: string },
    thread: MacCallThread,
    args: MacHeldArgs,
    line: (decision: string) => void
  ): { listed: number } {
    const list = Array.isArray(args.held) ? args.held : []
    const keep = new Set(list.map((h) => `${HELD_ROW_PREFIX}${h.id}`))
    for (const [id, row] of [...this.heldRows])
      if (row.environmentId === env.id && row.sessionId === thread.id && !keep.has(id))
        this.dropHeldRow(id)
    for (const h of list) {
      const id = `${HELD_ROW_PREFIX}${h.id}`
      if (this.heldRows.has(id)) continue
      const row: MacBridgeRequest = {
        id,
        environmentId: env.id,
        hostName: env.name,
        sessionId: thread.id,
        threadTitle: String(thread.title ?? ''),
        kind: h.method === 'mac.writeFile' ? 'write' : h.method === 'mac.run' || h.method === 'mac.jobStart' ? 'run' : 'read',
        method: h.method === 'mac.jobStart' ? 'mac.run' : h.method,
        ...(h.argv ? { argv: h.argv } : {}),
        ...(h.command !== undefined ? { command: h.command } : {}),
        ...(h.cwd !== undefined ? { cwd: h.cwd } : {}),
        ...(h.path !== undefined ? { path: h.path } : {}),
        ...(h.bytes !== undefined ? { bytes: h.bytes } : {}),
        ...(h.method === 'mac.jobStart' ? { interactive: true as const } : {}),
        createdAt: typeof h.since === 'number' ? h.since : Date.now(),
        expiresAt: Number.MAX_SAFE_INTEGER,
        status: 'paused'
      }
      this.heldRows.set(id, row)
      this.emit({ push: 'macBridge.request', request: row })
    }
    line(`${list.length} held`)
    return { listed: list.length }
  }

  private dropHeldRow(id: string): void {
    if (!this.heldRows.delete(id)) return
    this.emit({ push: 'macBridge.resolved', id, outcome: 'done' })
  }

  // ── a call from a box ──────────────────────────────────────────────

  async handle(
    method: MacPeerMethod,
    wire: Extract<MacBridgePush, { push: 'peer.call' }>['params'],
    ctx: {
      from: string
      deadlineAt: number
      /** The box's `peer.call` id (a `mac.cancel` names it); absent from a test's direct call. */
      callId?: string
      progress?: (chunk: string, skipped?: number) => void
    }
  ): Promise<unknown> {
    // Other offers route before the bridge. Refuse them here if their handler is absent.
    if (isCrossHostPeerMethod(method) || isHostDevicesPeerMethod(method) || isPublishPeerMethod(method))
      throw new Error(`${method} is not a Mac bridge call`)
    const params = wire as MacCallParams
    const env = this.deps.environments().find((e) => e.id === ctx.from)
    const thread = params?.thread
    if (!env) throw new Error('this Mac does not know that host')
    if (!thread || typeof thread.id !== 'string') throw new Error('the call names no thread')
    const line = (decision: string): void =>
      this.log(`${env.name} (${env.id}) thread=${thread.id} ${method} → ${decision}`)
    if (isMacPausePeerMethod(method))
      return method === 'mac.cancel'
        ? this.cancel(env, thread, params.args as MacCancelArgs, line)
        : this.held(env, thread, params.args as MacHeldArgs, line)
    // The box holds a paused thread's commands, jobs and writes itself; only a read comes marked, and only a prompt-free one is answered.
    if (thread.paused && !['mac.readFile', 'mac.listDir', 'mac.fetchFile'].includes(method)) {
      line('refused (paused)')
      throw new Error(REFUSED_PAUSED)
    }
    if (method === 'mac.writeFile')
      return this.writeFile(env, thread, params.args, ctx.deadlineAt, ctx.callId)
    const policy = this.policyOf(env.id)
    const unattended = threadRunsUnattended(thread)
    if (policy === 'off') {
      line('refused (bridge off)')
      throw new Error(
        "the Mac bridge is off for this host: turn it on in the Mac's Settings → Remote access"
      )
    }
    if (isMacJobPeerMethod(method))
      return this.jobs.handle(env, thread, method, params.args, {
        policy,
        deadlineAt: ctx.deadlineAt,
        line,
        callId: ctx.callId
      })
    if (method === 'mac.run') {
      if (policy !== 'read+run' && policy !== 'full') {
        line('refused (policy read)')
        throw new Error(
          "this host may read on the Mac but not run commands (the Mac's Settings → Remote access)"
        )
      }
      return this.run(env, thread, params.args, ctx.deadlineAt, line, ctx.progress, ctx.callId)
    }
    const schema =
      method === 'mac.readFile'
        ? MacReadFileArgsSchema
        : method === 'mac.listDir'
          ? MacListDirArgsSchema
          : MacFetchFileArgsSchema
    const args = schema.parse(params.args) as { path: string; maxBytes?: number }
    // Decide first, touch the file after: a path the policy does not admit
    // asks (or was refused above) whether or not it exists.
    const real = macPath(args.path, this.home)
    const isDir = method === 'mac.listDir'
    const full = policy === 'full' ? { home: this.home } : null
    const verdict = readVerdict(real, {
      managed: this.deps.managedRoots(),
      shared: this.sharedOf(env.id),
      remembered: this.rules.readFolders(env.id, thread.id),
      full
    })
    if (verdict.allow || unattended) {
      if (verdict.allow && verdict.why === 'remembered') this.rules.creditRead(env.id, thread.id, real)
      line(`allowed (${verdict.allow ? verdict.why : 'full access'})`)
    } else if (thread.paused) {
      // A paused thread's read goes only where it needs no prompt: nobody asks the person for a thread that is not running.
      line('refused (paused)')
      throw new Error(REFUSED_PAUSED)
    } else {
      // Under full only keys, credentials and the dirs above home ask: each
      // time, never remembered as a folder (that would admit the secret too).
      const folder = full ? null : rememberFolder(real, isDir, this.home)
      const { id, answer } = this.ask(
        {
          environmentId: env.id,
          hostName: env.name,
          sessionId: thread.id,
          threadTitle: String(thread.title ?? ''),
          kind: 'read',
          method,
          path: real,
          ...(folder ? { folder } : {})
        },
        Math.min(Date.now() + MAC_APPROVAL_WAIT_MS, ctx.deadlineAt - REPLY_MARGIN_MS),
        false,
        ctx.callId
      )
      const decision = await answer
      if (!decision.allow) {
        line(decision.outcome)
        throw new Error(
          decision.outcome === 'expired'
            ? 'nobody at the Mac answered in time'
            : 'denied at the Mac'
        )
      }
      const keep = readRemembers(decision.remember) && !!folder
      if (keep) this.rules.addRead(ruleThread(env, thread), folder)
      line(`allowed (asked${keep ? ', folder remembered' : ''})`)
      this.finish(id, 'allowed')
    }
    if (method === 'mac.listDir') return listDir(real)
    if (method === 'mac.readFile') return readMacFile(real, args.maxBytes ?? MAC_READ_DEFAULT_BYTES)
    return fetchMacFile(real)
  }

  private async run(
    env: { id: string; name: string },
    thread: MacCallThread,
    raw: unknown,
    deadlineAt: number,
    line: (decision: string) => void,
    progress?: (chunk: string, skipped?: number) => void,
    callId?: string
  ): Promise<MacRunResult> {
    const args = MacRunArgsSchema.parse(raw)
    if (!args.argv === !args.command) throw new Error('mac.run takes argv or command, one of them')
    const cwd = args.cwd ? macPath(args.cwd, this.home) : realSpelling(this.home)
    if (!existsSync(cwd) || !statSync(cwd).isDirectory())
      throw new Error(`no such folder on the Mac: ${cwd}`)
    const timeoutMs = args.timeoutMs ?? MAC_RUN_DEFAULT_TIMEOUT_MS
    const spec = { ...(args.argv ? { argv: args.argv } : { command: args.command }), cwd }
    const askUntil = Math.min(
      Date.now() + MAC_APPROVAL_WAIT_MS,
      deadlineAt - timeoutMs - REPLY_MARGIN_MS
    )
    if (askUntil <= Date.now()) throw new Error('the call left no time to ask the Mac')
    const rule = this.rules.runAllowed(env.id, thread.id, spec)
    // Full access on the box: decided at once, as a remembered command is.
    const unattended = threadRunsUnattended(thread)
    const shown = runPresentation({
      remembered: !!rule,
      unattended,
      showRunning: this.showRunningOf(env.id)
    })
    // Every command is listed on the Mac, remembered or not: a remembered one
    // starts at once, as running, and is quiet (no card) unless the host shows them.
    const { id, answer } = this.ask(
      {
        environmentId: env.id,
        hostName: env.name,
        sessionId: thread.id,
        threadTitle: String(thread.title ?? ''),
        kind: 'run',
        method: 'mac.run',
        ...spec,
        timeoutMs,
        ...runOffer(spec, this.home)
      },
      askUntil,
      !shown.prompt && shown.quiet,
      callId
    )
    const remembered = !shown.prompt
    const decision = remembered
      ? { allow: true, remember: false as MacDecideRemember, outcome: 'allowed' as const }
      : await answer
    if (remembered) this.pendingById.get(id)?.decide(true, false)
    if (!decision.allow) {
      line(decision.outcome)
      throw new Error(
        decision.outcome === 'expired' ? 'nobody at the Mac answered in time' : 'denied at the Mac'
      )
    }
    const kind = runRememberKind(decision.remember)
    const made = kind ? this.rules.addRun(ruleThread(env, thread), kind, spec) : null
    line(
      `allowed (${rule ? `remembered${rule.kind === 'exact' ? '' : `: ${rule.kind}`}` : unattended ? 'full access' : made ? `asked, ${made.kind === 'exact' ? 'command' : made.kind} remembered` : 'asked'}${!shown.prompt && shown.quiet ? ', quiet' : ''}) argv0=${basename(args.argv?.[0] ?? args.command?.split(/\s/)[0] ?? '')}`
    )
    // The load guard: at the host's cap, or with the Mac over its load limit,
    // the command waits its turn here, within the time the call left for the
    // command to still get its whole timeout.
    await this.hold(env.id, id, deadlineAt - timeoutMs - REPLY_MARGIN_MS, line)
    const p = this.pendingById.get(id)
    let running: RunningCommand
    try {
      running = (this.deps.run ?? runMacCommand)({
        ...spec,
        timeoutMs: Math.max(1_000, Math.min(timeoutMs, deadlineAt - Date.now() - REPLY_MARGIN_MS)),
        ...(this.deps.shell ? { shell: this.deps.shell } : {}),
        // The output streams to the box while it runs (peer.progress); the reply still carries it whole.
        ...(progress ? { onOutput: progress } : {})
      })
    } catch (err) {
      this.finish(id, 'stopped')
      throw err
    }
    if (p) {
      p.stop = running.stop
      p.request = { ...p.request, status: 'running', held: undefined }
      delete p.request.held
      this.emit({ push: 'macBridge.request', request: p.request })
    }
    const result = await running.result
    this.finish(id, result.timedOut || result.signal ? 'stopped' : 'done')
    line(
      `ran: exit ${result.exitCode ?? result.signal}${result.timedOut ? ', timed out' : ''}${result.truncated ? ', output capped' : ''}`
    )
    return result
  }

  // ── interactive jobs (macJobs.ts) ────────────────────────────────────

  private jobsInstance: MacJobs | null = null
  /** mac.run background: true and the calls on its job; the card is mac.run's, marked interactive. */
  get jobs(): MacJobs {
    this.jobsInstance ??= new MacJobs({
      ask: (shape, until, remembered, callId) => {
        // A remembered job starts at once, as running; it is quiet (no card)
        // unless the host shows running commands (runPresentation).
        const asked = this.ask(
          shape,
          until,
          remembered && !this.showRunningOf(shape.environmentId),
          callId
        )
        if (remembered) this.pendingById.get(asked.id)?.decide(true, false)
        return asked
      },
      hold: (envId, id, until, line) => this.hold(envId, id, until, line),
      running: (id, stop) => {
        const p = this.pendingById.get(id)
        if (!p) return
        p.stop = stop
        p.request = { ...p.request, status: 'running' }
        delete p.request.held
        this.emit({ push: 'macBridge.request', request: p.request })
      },
      finish: (id, outcome) => this.finish(id, outcome),
      home: this.home,
      ...(this.deps.shell ? { shell: this.deps.shell } : {}),
      ...(this.deps.jobSpawner ? { spawner: this.deps.jobSpawner } : {}),
      log: this.log
    })
    return this.jobsInstance
  }

  close(): void {
    this.jobsInstance?.closeAll()
    this.guard.close()
    this.heldRows.clear()
    for (const [id, p] of this.pendingById) {
      p.stop?.()
      p.decide(false, false)
      this.finish(id, 'expired')
    }
    this.rules.clear()
    this.listeners.clear()
  }

  /** mac.writeFile (macBridgeWrite.ts): this bridge's prompt and log, the policy read raw (a level above read this build does not know writes). */
  private writeFile(
    env: { id: string; name: string },
    thread: { id: string; title: string },
    args: unknown,
    deadlineAt: number,
    callId?: string
  ): Promise<MacWriteFileResult> {
    return serveMacWrite(
      {
        env,
        thread,
        policy: this.deps.store.getSetting(`${POLICY_PREFIX}${env.id}`),
        home: this.home,
        managed: this.deps.managedRoots(),
        shared: this.sharedOf(env.id),
        remembered: writeFoldersOf(this, env.id, thread.id),
        ask: (shape, until) => this.ask(shape, until, false, callId),
        finish: (id, outcome) => this.finish(id, outcome),
        link: this.deps.link(env.id),
        log: this.log
      },
      args,
      deadlineAt
    )
  }
}

// ── the filesystem side ──────────────────────────────────────────────

async function listDir(real: string): Promise<MacListDirResult> {
  const st = await stat(real)
  if (!st.isDirectory()) throw new Error(`not a folder: ${real}`)
  const names = (await readdir(real)).sort()
  const entries: MacDirEntry[] = []
  for (const name of names.slice(0, MAC_LIST_MAX_ENTRIES)) {
    try {
      const s = await lstat(`${real}${real.endsWith(sep) ? '' : sep}${name}`)
      entries.push({
        name,
        kind: s.isSymbolicLink() ? 'link' : s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other',
        size: s.size,
        mtime: Math.round(s.mtimeMs)
      })
    } catch {
      /* gone between readdir and lstat */
    }
  }
  return { path: real, entries, truncated: names.length > MAC_LIST_MAX_ENTRIES }
}

async function readMacFile(real: string, maxBytes: number): Promise<MacReadFileResult> {
  const st = await stat(real)
  if (!st.isFile()) throw new Error(`not a file: ${real}`)
  const fh = await open(real, 'r')
  try {
    const want = Math.min(maxBytes, st.size)
    const buf = Buffer.alloc(want)
    const { bytesRead } = await fh.read(buf, 0, want, 0)
    const bytes = buf.subarray(0, bytesRead)
    const text = asText(bytes)
    return {
      path: real,
      size: st.size,
      bytes: bytesRead,
      truncated: st.size > bytesRead,
      encoding: text === null ? 'base64' : 'utf8',
      content: text ?? bytes.toString('base64')
    }
  } finally {
    await fh.close()
  }
}

async function fetchMacFile(real: string): Promise<MacFetchFileWire> {
  const st = await stat(real)
  if (!st.isFile()) throw new Error(`not a file: ${real}`)
  if (st.size > MAC_FETCH_MAX_BYTES)
    throw new Error(`too large to fetch: ${st.size} bytes (the limit is ${MAC_FETCH_MAX_BYTES})`)
  const data = await readFile(real)
  return {
    name: basename(real),
    size: data.length,
    mtime: Math.round(st.mtimeMs),
    dataBase64: data.toString('base64')
  }
}

/** The Mac's own renderer's macBridge.* methods (all local). */
export function handleMacBridge(
  req: ClientRequest,
  bridge: MacBridge
): { handled: true; result: unknown } | { handled: false } {
  switch (req.method) {
    case 'macBridge.pending':
      return { handled: true, result: bridge.pending() }
    case 'macBridge.decide':
      return {
        handled: true,
        result: bridge.decide(req.params.id, req.params.allow, req.params.remember ?? false)
      }
    case 'macBridge.policy.get':
      return { handled: true, result: bridge.hosts() }
    case 'macBridge.policy.set':
      return {
        handled: true,
        result: bridge.setPolicy(req.params.environmentId, req.params.policy)
      }
    case 'macBridge.shared.set':
      return {
        handled: true,
        result: bridge.setShared(req.params.environmentId, req.params.folders)
      }
    case 'macBridge.showRunning.set':
      return {
        handled: true,
        result: bridge.setShowRunning(req.params.environmentId, req.params.show)
      }
    case 'macBridge.limits.set':
      return {
        handled: true,
        result: bridge.setLimits(req.params.environmentId, {
          ...(req.params.maxRunning !== undefined ? { maxRunning: req.params.maxRunning } : {}),
          ...(req.params.maxThreads !== undefined ? { maxThreads: req.params.maxThreads } : {})
        })
      }
    case 'macBridge.loadLimit.set':
      return { handled: true, result: bridge.setLoadLimit(req.params.limit) }
    case 'macBridge.load.get':
      return { handled: true, result: bridge.loadStatus() }
    case 'macBridge.admitThread':
      return { handled: true, result: bridge.admitThread(req.params.environmentId) }
    case 'macBridge.rules.list':
      return { handled: true, result: bridge.rules.list(req.params?.sessionId) }
    case 'macBridge.rules.forget':
      return {
        handled: true,
        result: bridge.rules.forget(req.params.sessionId, req.params.ruleId)
      }
    default:
      return { handled: false }
  }
}

/** The thread a remember rule is filed under. */
function ruleThread(
  env: { id: string; name: string },
  thread: { id: string; title?: string }
): { environmentId: string; hostName: string; sessionId: string; threadTitle: string } {
  return {
    environmentId: env.id,
    hostName: env.name,
    sessionId: thread.id,
    threadTitle: String(thread.title ?? '')
  }
}
