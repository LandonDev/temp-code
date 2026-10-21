import { randomBytes } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { lstat, open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { ClientRequest, ServerPush } from '@shared/contract'
import {
  MAC_APPROVAL_WAIT_MS,
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
  type MacBridgeHostPolicy,
  type MacBridgeOutcome,
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
import { isMacJobPeerMethod, type MacPeerMethod } from '@shared/contract-macjobs'
import { MacJobs, type JobSpawner } from './macJobs'

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
}

/** A decide's remember (contract-macbridge-rules.ts). */
type Remember = MacDecideRemember

export class MacBridge {
  private readonly pendingById = new Map<string, Pending>()
  private readonly listeners = new Set<(push: MacBridgePush) => void>()
  /** Remembered approvals per (host, thread), in memory only (macBridgeRules.ts). */
  readonly rules: MacBridgeRuleBook
  private readonly registered = new Set<string>()
  private readonly home: string
  private readonly log: (line: string) => void

  constructor(private readonly deps: MacBridgeDeps) {
    this.home = deps.home ?? homedir()
    this.rules = new MacBridgeRuleBook(this.home)
    this.log = deps.log ?? ((line) => console.log(`[mac-bridge] ${line}`))
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

  hosts(): MacBridgeHostPolicy[] {
    return this.deps.environments().map((e) => ({
      environmentId: e.id,
      name: e.name,
      policy: this.policyOf(e.id),
      shared: this.sharedOf(e.id),
      showRunning: this.showRunningOf(e.id),
      registered: this.registered.has(e.id)
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
        offers: [MAC_BRIDGE_OFFER],
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
    return [...this.pendingById.values()]
      .map((p) => p.request)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  decide(id: string, allow: boolean, remember: MacDecideRemember = false): { ok: true } {
    const p = this.pendingById.get(id)
    if (!p) throw new Error('that request is no longer waiting')
    if (p.request.status === 'running') {
      if (allow) throw new Error('that command is already running')
      p.stop?.()
      return { ok: true }
    }
    p.decide(allow, remember)
    return { ok: true }
  }

  /**
   * Ask the person at the Mac; resolves false on a denial or when the wait
   * runs out. A quiet request is one the caller decides at once and the
   * renderer never draws (runPresentation); it is still listed, with Stop.
   */
  private ask(
    shape: Omit<MacBridgeRequest, 'id' | 'createdAt' | 'expiresAt' | 'status' | 'quiet'>,
    until: number,
    quiet = false
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
    const p = this.pendingById.get(id)
    if (!p) return
    clearTimeout(p.timer)
    this.pendingById.delete(id)
    this.emit({ push: 'macBridge.resolved', id, outcome })
  }

  // ── a call from a box ──────────────────────────────────────────────

  async handle(
    method: MacPeerMethod,
    params: MacCallParams,
    ctx: {
      from: string
      deadlineAt: number
      progress?: (chunk: string, skipped?: number) => void
    }
  ): Promise<unknown> {
    const env = this.deps.environments().find((e) => e.id === ctx.from)
    const thread = params?.thread
    if (!env) throw new Error('this Mac does not know that host')
    if (!thread || typeof thread.id !== 'string') throw new Error('the call names no thread')
    if (method === 'mac.writeFile') return this.writeFile(env, thread, params.args, ctx.deadlineAt)
    const policy = this.policyOf(env.id)
    const unattended = threadRunsUnattended(thread)
    const line = (decision: string): void =>
      this.log(`${env.name} (${env.id}) thread=${thread.id} ${method} → ${decision}`)
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
        line
      })
    if (method === 'mac.run') {
      if (policy !== 'read+run' && policy !== 'full') {
        line('refused (policy read)')
        throw new Error(
          "this host may read on the Mac but not run commands (the Mac's Settings → Remote access)"
        )
      }
      return this.run(env, thread, params.args, ctx.deadlineAt, line, ctx.progress)
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
        Math.min(Date.now() + MAC_APPROVAL_WAIT_MS, ctx.deadlineAt - REPLY_MARGIN_MS)
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
    progress?: (chunk: string, skipped?: number) => void
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
      !shown.prompt && shown.quiet
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
    const p = this.pendingById.get(id)
    const running: RunningCommand = (this.deps.run ?? runMacCommand)({
      ...spec,
      timeoutMs: Math.max(1_000, Math.min(timeoutMs, deadlineAt - Date.now() - REPLY_MARGIN_MS)),
      ...(this.deps.shell ? { shell: this.deps.shell } : {}),
      // The output streams to the box while it runs (peer.progress); the reply still carries it whole.
      ...(progress ? { onOutput: progress } : {})
    })
    if (p) {
      p.stop = running.stop
      p.request = { ...p.request, status: 'running' }
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
      ask: (shape, until, remembered) => {
        // A remembered job starts at once, as running; it is quiet (no card)
        // unless the host shows running commands (runPresentation).
        const asked = this.ask(
          shape,
          until,
          remembered && !this.showRunningOf(shape.environmentId)
        )
        if (remembered) this.pendingById.get(asked.id)?.decide(true, false)
        return asked
      },
      running: (id, stop) => {
        const p = this.pendingById.get(id)
        if (!p) return
        p.stop = stop
        p.request = { ...p.request, status: 'running' }
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
    deadlineAt: number
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
        ask: (shape, until) => this.ask(shape, until),
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
