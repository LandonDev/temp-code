import { randomBytes } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { lstat, open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path'
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
  type MacMethod,
  type MacReadFileResult,
  type MacRunResult
} from '@shared/contract-macbridge'
import { insideRoots, realSpelling } from './fence'
import { runMacCommand, type RunningCommand } from './macRunner'
import { servePeerCall, type LinkRequest } from './peerCalls'

/**
 * The Mac side of the Mac bridge (docs/box.md "The Mac bridge: what a box
 * thread may touch on the Mac"). A box thread's mac.* call arrives here as a
 * `peer.call` push on the link this Mac's main process holds to that box,
 * and the Mac decides everything:
 *
 *  - Per box, a policy (`macBridge.policy.<envId>`): off (the default) |
 *    read | read+run, and shared folders (`macBridge.shared.<envId>`):
 *    absolute dirs, never '/', never the home directory or one above it.
 *  - Reads and listings inside this Mac's app-managed roots or a shared
 *    folder go through without a prompt; any other path asks the person at
 *    the Mac, once per request, with "allow this folder for this thread".
 *  - Every command asks, showing argv and cwd, whatever the thread's
 *    permission mode on the box, with "allow this exact command for this
 *    thread". It runs through the login shell (macRunner.ts).
 *
 * The prompt is a `macBridge.request` push to this Mac's own local sockets
 * (its renderer), answered by `macBridge.decide`, which is local-only: no
 * key, no phone and no box can ever answer one. Remember rules live in
 * memory, per (box, thread), and end with the app. One log line per call
 * names the host, thread, method and decision, never a file's contents.
 */

export const POLICY_PREFIX = 'macBridge.policy.'
export const SHARED_PREFIX = 'macBridge.shared.'
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

export type ReadVerdict =
  { allow: true; why: 'managed' | 'shared' | 'remembered' } | { allow: false }

/** Whether a read goes through without asking. */
export function readVerdict(
  real: string,
  rules: { managed: readonly string[]; shared: readonly string[]; remembered: readonly string[] }
): ReadVerdict {
  if (rules.managed.length && insideRoots(real, rules.managed))
    return { allow: true, why: 'managed' }
  if (rules.shared.length && insideRoots(real, rules.shared)) return { allow: true, why: 'shared' }
  if (rules.remembered.length && insideRoots(real, rules.remembered))
    return { allow: true, why: 'remembered' }
  return { allow: false }
}

/** The key "allow this exact command" remembers: argv or the command string, and the cwd. */
export const commandKey = (spec: { argv?: string[]; command?: string; cwd: string }): string =>
  JSON.stringify([spec.argv ?? null, spec.command ?? null, spec.cwd])

/** A box path for this Mac: absolute, no `~` (the box's home is not this one). */
export function macPath(path: string): string {
  if (!isAbsolute(path)) throw new Error(`paths on the Mac must be absolute: ${path}`)
  return realSpelling(resolve(path))
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
  decide: (allow: boolean, remember: boolean) => void
  stop?: () => void
  timer: NodeJS.Timeout
}

interface ThreadMemory {
  folders: Set<string>
  commands: Set<string>
}

export class MacBridge {
  private readonly pendingById = new Map<string, Pending>()
  private readonly listeners = new Set<(push: MacBridgePush) => void>()
  private readonly memory = new Map<string, ThreadMemory>()
  private readonly registered = new Set<string>()
  private readonly home: string
  private readonly log: (line: string) => void

  constructor(private readonly deps: MacBridgeDeps) {
    this.home = deps.home ?? homedir()
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

  hosts(): MacBridgeHostPolicy[] {
    return this.deps.environments().map((e) => ({
      environmentId: e.id,
      name: e.name,
      policy: this.policyOf(e.id),
      shared: this.sharedOf(e.id),
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
      await request('peer.register', { from: this.deps.environmentId, offers: [MAC_BRIDGE_OFFER] })
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

  decide(id: string, allow: boolean, remember = false): { ok: true } {
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

  /** Ask the person at the Mac; resolves false on a denial or when the wait runs out. */
  private ask(
    shape: Omit<MacBridgeRequest, 'id' | 'createdAt' | 'expiresAt' | 'status'>,
    until: number
  ): {
    id: string
    answer: Promise<{ allow: boolean; remember: boolean; outcome: MacBridgeOutcome }>
  } {
    const id = `mb_${randomBytes(9).toString('base64url')}`
    const now = Date.now()
    const request: MacBridgeRequest = {
      ...shape,
      id,
      createdAt: now,
      expiresAt: until,
      status: 'pending'
    }
    const answer = new Promise<{ allow: boolean; remember: boolean; outcome: MacBridgeOutcome }>(
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

  private memoryOf(envId: string, sessionId: string): ThreadMemory {
    const key = `${envId}\0${sessionId}`
    let m = this.memory.get(key)
    if (!m) this.memory.set(key, (m = { folders: new Set(), commands: new Set() }))
    return m
  }

  // ── a call from a box ──────────────────────────────────────────────

  async handle(
    method: MacMethod,
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
    const policy = this.policyOf(env.id)
    const line = (decision: string): void =>
      this.log(`${env.name} (${env.id}) thread=${thread.id} ${method} → ${decision}`)
    if (policy === 'off') {
      line('refused (bridge off)')
      throw new Error(
        "the Mac bridge is off for this host: turn it on in the Mac's Settings → Remote access"
      )
    }
    if (method === 'mac.run') {
      if (policy !== 'read+run') {
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
    const real = macPath(args.path)
    const isDir = method === 'mac.listDir'
    const memory = this.memoryOf(env.id, thread.id)
    const verdict = readVerdict(real, {
      managed: this.deps.managedRoots(),
      shared: this.sharedOf(env.id),
      remembered: [...memory.folders]
    })
    if (verdict.allow) line(`allowed (${verdict.why})`)
    else {
      const folder = rememberFolder(real, isDir, this.home)
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
      if (decision.remember && folder) memory.folders.add(folder)
      line(`allowed (asked${decision.remember && folder ? ', folder remembered' : ''})`)
      this.finish(id, 'allowed')
    }
    if (method === 'mac.listDir') return listDir(real)
    if (method === 'mac.readFile') return readMacFile(real, args.maxBytes ?? MAC_READ_DEFAULT_BYTES)
    return fetchMacFile(real)
  }

  private async run(
    env: { id: string; name: string },
    thread: { id: string; title: string },
    raw: unknown,
    deadlineAt: number,
    line: (decision: string) => void,
    progress?: (chunk: string, skipped?: number) => void
  ): Promise<MacRunResult> {
    const args = MacRunArgsSchema.parse(raw)
    if (!args.argv === !args.command) throw new Error('mac.run takes argv or command, one of them')
    const cwd = args.cwd ? macPath(args.cwd) : realSpelling(this.home)
    if (!existsSync(cwd) || !statSync(cwd).isDirectory())
      throw new Error(`no such folder on the Mac: ${cwd}`)
    const timeoutMs = args.timeoutMs ?? MAC_RUN_DEFAULT_TIMEOUT_MS
    const spec = { ...(args.argv ? { argv: args.argv } : { command: args.command }), cwd }
    const key = commandKey(spec)
    const memory = this.memoryOf(env.id, thread.id)
    const askUntil = Math.min(
      Date.now() + MAC_APPROVAL_WAIT_MS,
      deadlineAt - timeoutMs - REPLY_MARGIN_MS
    )
    if (askUntil <= Date.now()) throw new Error('the call left no time to ask the Mac')
    // Every command shows on the Mac, remembered or not: a remembered one starts at once, as running.
    const { id, answer } = this.ask(
      {
        environmentId: env.id,
        hostName: env.name,
        sessionId: thread.id,
        threadTitle: String(thread.title ?? ''),
        kind: 'run',
        method: 'mac.run',
        ...spec,
        timeoutMs
      },
      askUntil
    )
    const remembered = memory.commands.has(key)
    const decision = remembered
      ? { allow: true, remember: false, outcome: 'allowed' as const }
      : await answer
    if (remembered) this.pendingById.get(id)?.decide(true, false)
    if (!decision.allow) {
      line(decision.outcome)
      throw new Error(
        decision.outcome === 'expired' ? 'nobody at the Mac answered in time' : 'denied at the Mac'
      )
    }
    if (decision.remember) memory.commands.add(key)
    line(
      `allowed (${remembered ? 'remembered' : decision.remember ? 'asked, command remembered' : 'asked'}) argv0=${basename(args.argv?.[0] ?? args.command?.split(/\s/)[0] ?? '')}`
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

  close(): void {
    for (const [id, p] of this.pendingById) {
      p.stop?.()
      p.decide(false, false)
      this.finish(id, 'expired')
    }
    this.listeners.clear()
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
    default:
      return { handled: false }
  }
}
