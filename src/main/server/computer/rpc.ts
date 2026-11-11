import type { AppComputerAnswer, AppComputerToolsAnswer, ComputerPush, ComputerServiceState, ComputerSessionsAnswer } from '@shared/contract-computer'
import { parseMacComputerKey } from '@shared/contract-maccomputer'
import { hostErrorLine } from '@shared/computer/hostErrors'
import { COMPUTER_RESULT_TOOL, heldCallWhat, heldTimings, type HeldTimings } from '@shared/computer/heldCalls'
import { ComputerResultInputSchema } from '@shared/computer/tools'
import type { SessionMeta, SessionStatus } from '@shared/events'
import type { MacThreadTokens } from '../macTools'
import type { ComputerBridge } from './bridge'
import { computerAnswer, computerToolList, type ComputerHost } from './mcp'
import { PendingCalls } from './pending'
import { refusal, type ComputerToolOutcome } from './result'

/**
 * The computer methods on the app's own wire (src/shared/contract-computer.ts):
 * the live sessions and Stop for the desktop, and the codex and Muse bridge's
 * tools. A bridge call carries its thread's token and is cancelled by
 * `app.computerCancel` or by its socket closing (the bridge exited), so a
 * call the harness gave up on can never act on a late Allow. A call held 20 s
 * answers with an id and waits here, unread and not running, for
 * `computer_result` (pending.ts): Codex's code-mode cells give up on a tool
 * after their yield and Muse blocks with nothing to show.
 *
 * On a host where computer use is unavailable (the box), a thread whose Mac
 * bridge offers it is served by the ComputerBridge instead: its calls cross
 * to the Mac, its rows are the bridge's mirrored ones, Stop is the bridge's.
 * On the Mac, the sessions it holds for box threads (keyed by box and
 * thread, macComputer.ts) are its own business and stay out of its push.
 */

export interface ComputerRpcBridge {
  bridge: ComputerBridge
  tokens: MacThreadTokens
}

/** Pushes at most four a second. */
export const COMPUTER_PUSH_MS = 250

const OFF: ComputerServiceState = { state: 'unavailable', reason: 'computer use runs on a Mac', restarts: 0, permissions: null }

/** A thread's pending calls are cancelled when its turn settles or it pauses; `waiting` is not a settle. */
const ENDS_PENDING: readonly SessionStatus[] = ['idle', 'done', 'error', 'stopped', 'watching', 'paused']

export interface ComputerRpcOptions {
  /** registry.setToolHold: the thread's status line says its computer hold */
  setToolHold?: (threadId: string, line: string | null) => void
  timings?: HeldTimings
}

export class ComputerRpc {
  private readonly listeners = new Set<(push: ComputerPush) => void>()
  private timer: NodeJS.Timeout | null = null
  private lastPush = 0
  private readonly stops: (() => void)[] = []
  private readonly sockets = new Set<ComputerSocket>()
  /** each thread's hold as the scheduler or the bridge said it, and what the status line was last told */
  private readonly holds = new Map<string, string>()
  private readonly shown = new Map<string, string>()
  private readonly timings: HeldTimings

  constructor(
    private readonly host: ComputerHost | null,
    private readonly unavailableReason: () => string | null = () => null,
    private readonly bridged: ComputerRpcBridge | null = null,
    private readonly opts: ComputerRpcOptions = {}
  ) {
    this.timings = opts.timings ?? heldTimings()
    // a row that moved may be a hold that began or ended: every waiting reader looks again
    const moved = (): void => {
      this.schedule()
      for (const s of this.sockets) s.poke()
    }
    if (host) {
      this.stops.push(host.sessions.onRows(moved))
      this.stops.push(host.service.onState(() => this.schedule()))
    }
    if (bridged) this.stops.push(bridged.bridge.onRows(moved))
  }

  sessions(): ComputerSessionsAnswer {
    const mirrored = this.bridged?.bridge.rows() ?? []
    if (!this.host) return { service: { ...OFF, reason: this.unavailableReason() ?? OFF.reason }, sessions: mirrored }
    const own = this.host.sessions.rows().filter((r) => !parseMacComputerKey(r.threadId))
    return { service: this.host.service.state(), sessions: [...own, ...mirrored] }
  }

  async stop(sessionId: string): Promise<{ stopped: boolean }> {
    if (this.bridged?.bridge.rows().some((r) => r.threadId === sessionId)) return { stopped: await this.bridged.bridge.stop(sessionId) }
    return { stopped: this.host ? await this.host.sessions.stop(sessionId) : false }
  }

  onPush(fn: (push: ComputerPush) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** One socket's bridge calls, each abortable by its MCP request id. */
  socket(): ComputerSocket {
    const socket = new ComputerSocket(this.host, this.bridged, {
      timings: this.timings,
      readerChanged: (threadId) => this.showHold(threadId),
      closed: () => this.sockets.delete(socket)
    })
    this.sockets.add(socket)
    return socket
  }

  /** registry.onMeta: a settled or paused thread's pending calls are cancelled on every socket. */
  onMeta(meta: Pick<SessionMeta, 'id' | 'status' | 'archived'>): void {
    if (!meta.archived && !ENDS_PENDING.includes(meta.status)) return
    for (const s of this.sockets) s.settle(meta.id, meta.status === 'paused' ? 'paused' : 'settled')
  }

  /**
   * A thread's computer hold, from the scheduler or the bridge: its status line
   * says it, except while the call answered early and nobody reads it (the
   * Activity row keeps it); a reader coming back shows it again.
   */
  toolHold(threadId: string, line: string | null): void {
    if (line === null) this.holds.delete(threadId)
    else this.holds.set(threadId, line)
    this.showHold(threadId)
  }

  private showHold(threadId: string): void {
    const unread = [...this.sockets].some((s) => s.unread(threadId))
    const line = unread ? null : (this.holds.get(threadId) ?? null)
    if ((this.shown.get(threadId) ?? null) === line) return
    if (line === null) this.shown.delete(threadId)
    else this.shown.set(threadId, line)
    this.opts.setToolHold?.(threadId, line)
  }

  close(): void {
    for (const stop of this.stops.splice(0)) stop()
    if (this.timer) clearTimeout(this.timer)
    for (const s of [...this.sockets]) s.close()
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(
      () => {
        this.timer = null
        this.lastPush = Date.now()
        const push: ComputerPush = { push: 'computer', ...this.sessions() }
        for (const fn of this.listeners) fn(push)
      },
      Math.max(0, this.lastPush + COMPUTER_PUSH_MS - Date.now())
    )
    this.timer.unref?.()
  }
}

type CallId = string | number

export interface ComputerSocketOptions {
  timings?: HeldTimings
  readerChanged?: (threadId: string) => void
  closed?: () => void
}

export class ComputerSocket {
  private readonly calls = new Map<string, AbortController>()
  private readonly pending: PendingCalls

  constructor(
    private readonly host: ComputerHost | null,
    private readonly bridged: ComputerRpcBridge | null = null,
    private readonly opts: ComputerSocketOptions = {}
  ) {
    this.pending = new PendingCalls({ ...(opts.timings ? { timings: opts.timings } : {}), ...(opts.readerChanged ? { readerChanged: opts.readerChanged } : {}) })
  }

  /**
   * Who serves a thread's calls: this host's sessions where computer use is
   * available, else its Mac through the bridge, else nobody. A call goes to
   * the Mac whenever the thread's bridge names one (the Mac refuses it in its
   * own words while its switch is off); the tools are listed only while that
   * Mac offers computer use.
   */
  private serverOf(sessionId: string, use: 'call' | 'list'): { local: ComputerHost } | { bridge: ComputerBridge } | null {
    if (this.host?.available()) return { local: this.host }
    const bridge = this.bridged?.bridge
    if (bridge && (use === 'call' ? bridge.bridged(sessionId) : bridge.offered(sessionId))) return { bridge }
    return null
  }

  async call(p: { sessionId: string; token: string; call: CallId; tool: string; args: Record<string, unknown>; images: 'parts' | 'none' }): Promise<AppComputerAnswer> {
    this.checkToken(p.sessionId, p.token)
    const server = this.serverOf(p.sessionId, 'call')
    if (!server) return computerAnswer(refusal(hostErrorLine('service_unavailable', 'computer use runs on a Mac')), 'none')
    const key = keyOf(p.sessionId, p.call)
    const abort = new AbortController()
    this.calls.get(key)?.abort()
    this.calls.set(key, abort)
    const threadId = p.sessionId
    try {
      let outcome: ComputerToolOutcome
      let opening: string[] = []
      if (p.tool === COMPUTER_RESULT_TOOL) {
        const parsed = ComputerResultInputSchema.safeParse(p.args)
        outcome = parsed.success
          ? await this.pending.result(threadId, parsed.data.id, parsed.data.cancel === true, abort.signal)
          : refusal(hostErrorLine('invalid_args', parsed.error.issues[0]?.message ?? 'refused'))
      } else {
        // the next call wins: a pending call of the thread is cancelled first, and this answer says what became of it
        opening = await this.pending.supersede(threadId)
        outcome = await this.pending.start(
          {
            threadId,
            what: heldCallWhat(p.tool, p.args),
            holdWords: () => ('local' in server ? localHold(server.local, threadId) : server.bridge.holdWords(threadId)),
            run: ({ signal, reader }) => {
              const ctx = { threadId, signal, reader }
              return 'local' in server ? server.local.sessions.run(ctx, p.tool, p.args) : server.bridge.run(ctx, p.tool, p.args)
            }
          },
          abort.signal
        )
      }
      opening = [...opening, ...this.pending.take(threadId)]
      return await computerAnswer(opening.length ? { ...outcome, steps: [...opening, ...outcome.steps] } : outcome, p.images)
    } finally {
      if (this.calls.get(key) === abort) this.calls.delete(key)
    }
  }

  /** A row moved: a waiting reader looks at its call's hold again. */
  poke(): void {
    this.pending.poke()
  }

  settle(threadId: string, why: 'settled' | 'paused'): void {
    this.pending.settle(threadId, why)
  }

  /** A call of the thread answered early and nobody reads it now. */
  unread(threadId: string): boolean {
    return this.pending.unread(threadId)
  }

  cancel(p: { sessionId: string; token: string; call: CallId }): null {
    this.checkToken(p.sessionId, p.token)
    this.calls.get(keyOf(p.sessionId, p.call))?.abort()
    return null
  }

  tools(p: { sessionId: string; token: string }): AppComputerToolsAnswer {
    this.checkToken(p.sessionId, p.token)
    const server = this.serverOf(p.sessionId, 'list')
    if (!server) return { tools: [] }
    // the thread's words; the default ones for a thread the registry does not list
    const meta = ('local' in server ? server.local.sessions.meta(p.sessionId) : server.bridge.meta(p.sessionId)) ?? { provider: 'claude' as const, model: '' }
    return { tools: computerToolList(meta, { bridged: 'bridge' in server, result: true }) }
  }

  /** The socket closed: the bridge is gone, and so is every call it made, pending ones too. */
  close(): void {
    for (const abort of this.calls.values()) abort.abort()
    this.calls.clear()
    this.pending.closeAll()
    this.opts.closed?.()
  }

  private checkToken(sessionId: string, token: string): void {
    const tokens = this.host?.tokens ?? this.bridged?.tokens
    if (!tokens?.check(sessionId, token)) throw new Error('forbidden: not this thread\'s computer token')
  }
}

const keyOf = (sessionId: string, call: CallId): string => `${sessionId}\0${typeof call}:${call}`

/** What holds a thread's local call now: its row's held line, else null. */
function localHold(host: ComputerHost, threadId: string): string | null {
  const running = host.sessions.rowOf(threadId)?.running
  return running?.held ? running.words : null
}
