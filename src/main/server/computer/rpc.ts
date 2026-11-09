import type { AppComputerAnswer, AppComputerToolsAnswer, ComputerPush, ComputerServiceState, ComputerSessionsAnswer } from '@shared/contract-computer'
import { parseMacComputerKey } from '@shared/contract-maccomputer'
import { hostErrorLine } from '@shared/computer/hostErrors'
import type { MacThreadTokens } from '../macTools'
import type { ComputerBridge } from './bridge'
import { computerAnswer, computerToolList, type ComputerHost } from './mcp'
import { refusal } from './result'

/**
 * The computer methods on the app's own wire (src/shared/contract-computer.ts):
 * the live sessions and Stop for the desktop, and the codex and Muse bridge's
 * four tools. A bridge call carries its thread's token and is cancelled by
 * `app.computerCancel` or by its socket closing (the bridge exited), so a
 * call the harness gave up on can never act on a late Allow.
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

export class ComputerRpc {
  private readonly listeners = new Set<(push: ComputerPush) => void>()
  private timer: NodeJS.Timeout | null = null
  private lastPush = 0
  private readonly stops: (() => void)[] = []

  constructor(
    private readonly host: ComputerHost | null,
    private readonly unavailableReason: () => string | null = () => null,
    private readonly bridged: ComputerRpcBridge | null = null
  ) {
    if (host) {
      this.stops.push(host.sessions.onRows(() => this.schedule()))
      this.stops.push(host.service.onState(() => this.schedule()))
    }
    if (bridged) this.stops.push(bridged.bridge.onRows(() => this.schedule()))
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
    return new ComputerSocket(this.host, this.bridged)
  }

  close(): void {
    for (const stop of this.stops.splice(0)) stop()
    if (this.timer) clearTimeout(this.timer)
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

export class ComputerSocket {
  private readonly calls = new Map<string, AbortController>()

  constructor(
    private readonly host: ComputerHost | null,
    private readonly bridged: ComputerRpcBridge | null = null
  ) {}

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
    try {
      const ctx = { threadId: p.sessionId, signal: abort.signal }
      const outcome = 'local' in server ? await server.local.sessions.run(ctx, p.tool, p.args) : await server.bridge.run(ctx, p.tool, p.args)
      return await computerAnswer(outcome, p.images)
    } finally {
      if (this.calls.get(key) === abort) this.calls.delete(key)
    }
  }

  cancel(p: { sessionId: string; token: string; call: CallId }): null {
    this.checkToken(p.sessionId, p.token)
    this.calls.get(keyOf(p.sessionId, p.call))?.abort()
    return null
  }

  tools(p: { sessionId: string; token: string }): AppComputerToolsAnswer {
    this.checkToken(p.sessionId, p.token)
    const server = this.serverOf(p.sessionId, 'list')
    return { tools: server ? computerToolList({ bridged: 'bridge' in server }) : [] }
  }

  /** The socket closed: the bridge is gone, and so is every call it made. */
  close(): void {
    for (const abort of this.calls.values()) abort.abort()
    this.calls.clear()
  }

  private checkToken(sessionId: string, token: string): void {
    const tokens = this.host?.tokens ?? this.bridged?.tokens
    if (!tokens?.check(sessionId, token)) throw new Error('forbidden: not this thread\'s computer token')
  }
}

const keyOf = (sessionId: string, call: CallId): string => `${sessionId}\0${typeof call}:${call}`
