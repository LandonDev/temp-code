import { forwardedLine, type PortForwardInfo } from '@shared/contract-ports'
import type { ThreadResource } from '@shared/contract-resources'
import { notDevServer } from '@shared/devServerRules'

/**
 * Telling a thread where its dev server landed on the Mac (docs/box.md "Dev
 * servers on the box"), so it can hand the URL to a Mac child or a
 * computer-use run. One line per port, once:
 *
 *  - in the shell call's own result when the harness has a post-tool hook
 *    (claude): `tail` settles the call's ports, waits up to WAIT_MS for every
 *    Mac to bind them and answers "Forwarded to http://localhost:5174 on the
 *    Mac (5173 is taken there)";
 *  - otherwise (codex, or a port the poll found after the call ended), once
 *    the Macs bound it and its call is over, whispered into the thread's turn
 *    (or held ahead of its next message) after SETTLE_MS, naming the port and
 *    the command.
 *
 * A port the shared rules say is not a dev server (a test run's or the gate's
 * worker, a database, an MCP server) is never announced. A thread that
 * already runs another dev server (one opened by another call, or a Run for
 * it) hears that too: one dev server per thread, unless the second is for a
 * different feature (`oneServerLine`).
 */

export const WAIT_MS = 2_500
export const SETTLE_MS = 3_000

export interface PortTailDeps {
  settle: (sessionId: string, callId: string, output: string) => Promise<ThreadResource[]>
  whenBound: (ids: readonly string[], ms: number) => Promise<void>
  forwardsOf: (id: string) => PortForwardInfo[]
  /** The live port row behind a forward id, if it is a thread's. */
  row: (id: string) => ThreadResource | null
  /** Whether the call that opened it still runs. */
  running: (callId: string) => boolean
  /** The session the call ran in: a subagent's port is filed under its root, but the subagent is told. */
  sessionOfCall: (callId: string) => string | null
  whisper: (sessionId: string, text: string) => void
  /** The ports of the thread's other live dev servers: its other calls' rows and its runs. */
  others?: (row: ThreadResource) => number[]
  setTimer?: (fn: () => void, ms: number) => void
}

export class PortTail {
  private readonly told = new Set<string>()
  /** Rows a hook is waiting on right now: the whisper holds off. */
  private readonly inHook = new Set<string>()
  private readonly setTimer: (fn: () => void, ms: number) => void

  constructor(private readonly deps: PortTailDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => void setTimeout(fn, ms).unref?.())
  }

  private line(row: ThreadResource): string | null {
    if (notDevServer(Number(row.identifier), null, row.label)) return null
    const line = forwardedLine(Number(row.identifier), this.deps.forwardsOf(row.id))
    if (!line) return null
    const others = this.deps.others?.(row) ?? []
    return others.length ? `${line}\n${oneServerLine(others)}` : line
  }

  /** The hook's answer for one finished shell call. */
  async tail(sessionId: string, callId: string, output: string): Promise<string | null> {
    const rows = await this.deps.settle(sessionId, callId, output)
    if (!rows.length) return null
    for (const r of rows) this.inHook.add(r.id)
    try {
      await this.deps.whenBound(
        rows.map((r) => r.id),
        WAIT_MS
      )
      const lines: string[] = []
      for (const r of rows) {
        const line = this.line(r)
        if (!line || this.told.has(r.id)) continue
        this.told.add(r.id)
        lines.push(line)
      }
      return lines.join('\n') || null
    } finally {
      for (const r of rows) this.inHook.delete(r.id)
    }
  }

  /** The Macs bound (or unbound) some forwards: a thread not yet told hears it once its call is over. */
  bound(ids: readonly string[]): void {
    for (const id of ids) {
      if (this.told.has(id) || this.inHook.has(id)) continue
      this.setTimer(() => this.whisperIfDue(id), SETTLE_MS)
    }
  }

  /** A shell call ended: rows it opened that were bound while it ran are due now. */
  callEnded(ids: readonly string[]): void {
    this.bound(ids)
  }

  private whisperIfDue(id: string): void {
    if (this.told.has(id) || this.inHook.has(id)) return
    const row = this.deps.row(id)
    if (!row || row.kind !== 'port') return
    if (row.callId && this.deps.running(row.callId)) return
    const line = this.line(row)
    if (!line) return
    this.told.add(id)
    this.deps.whisper((row.callId && this.deps.sessionOfCall(row.callId)) || row.sessionId, `<dev-server port="${row.identifier}">\nThe dev server ${row.label} on port ${row.identifier}: ${line}\n</dev-server>`)
  }
}

/** What a thread with a dev server already running hears about a second one. */
export function oneServerLine(ports: readonly number[]): string {
  const where = ports.length === 1 ? `a dev server on port ${ports[0]}` : `dev servers on ports ${ports.join(', ')}`
  return `This thread already runs ${where}. Keep one dev server per thread: if this one replaces it, stop the old one; keep both only if this one is for a different feature, and say which.`
}
