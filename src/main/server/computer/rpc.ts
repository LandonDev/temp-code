import type { AppComputerAnswer, AppComputerToolsAnswer, ComputerPush, ComputerServiceState, ComputerSessionsAnswer } from '@shared/contract-computer'
import { hostErrorLine } from '@shared/computer/hostErrors'
import { computerAnswer, computerToolList, type ComputerHost } from './mcp'
import { refusal } from './result'

/**
 * The computer methods on the app's own wire (src/shared/contract-computer.ts):
 * the live sessions and Stop for the desktop, and the codex and Muse bridge's
 * four tools. A bridge call carries its thread's token and is cancelled by
 * `app.computerCancel` or by its socket closing (the bridge exited), so a
 * call the harness gave up on can never act on a late Allow.
 */

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
    private readonly unavailableReason: () => string | null = () => null
  ) {
    if (host) {
      this.stops.push(host.sessions.onRows(() => this.schedule()))
      this.stops.push(host.service.onState(() => this.schedule()))
    }
  }

  sessions(): ComputerSessionsAnswer {
    if (!this.host) return { service: { ...OFF, reason: this.unavailableReason() ?? OFF.reason }, sessions: [] }
    return { service: this.host.service.state(), sessions: this.host.sessions.rows() }
  }

  async stop(sessionId: string): Promise<{ stopped: boolean }> {
    return { stopped: this.host ? await this.host.sessions.stop(sessionId) : false }
  }

  onPush(fn: (push: ComputerPush) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** One socket's bridge calls, each abortable by its MCP request id. */
  socket(): ComputerSocket {
    return new ComputerSocket(this.host)
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

  constructor(private readonly host: ComputerHost | null) {}

  async call(p: { sessionId: string; token: string; call: CallId; tool: string; args: Record<string, unknown>; images: 'parts' | 'none' }): Promise<AppComputerAnswer> {
    this.checkToken(p.sessionId, p.token)
    if (!this.host?.available()) return computerAnswer(refusal(hostErrorLine('service_unavailable', 'computer use runs on a Mac')), 'none')
    const key = keyOf(p.sessionId, p.call)
    const abort = new AbortController()
    this.calls.get(key)?.abort()
    this.calls.set(key, abort)
    try {
      const outcome = await this.host.sessions.run({ threadId: p.sessionId, signal: abort.signal }, p.tool, p.args)
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
    return { tools: this.host?.available() ? computerToolList() : [] }
  }

  /** The socket closed: the bridge is gone, and so is every call it made. */
  close(): void {
    for (const abort of this.calls.values()) abort.abort()
    this.calls.clear()
  }

  private checkToken(sessionId: string, token: string): void {
    if (!this.host?.tokens.check(sessionId, token)) throw new Error('forbidden: not this thread\'s computer token')
  }
}

const keyOf = (sessionId: string, call: CallId): string => `${sessionId}\0${typeof call}:${call}`
