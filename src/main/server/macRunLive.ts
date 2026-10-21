import {
  MAC_RUN_LIVE_MS,
  MAC_RUN_LIVE_TAIL_BYTES,
  type MacRunArgs
} from '@shared/contract-macbridge'
import type { AgentEvent, EventRow } from '@shared/events'
import type { ProgressFrame } from './remote/peerStreams'

/**
 * A running mac_run, live in its thread (docs/box.md "The Mac bridge",
 * "mac_run streams"). The Mac streams the command's output as peer.progress
 * frames (remote/peerStreams.ts); here they become the same broadcast-only
 * partial tool-call row other streaming tools use (sessions.ts `append` with
 * `partial: true`, seq -1, never in the log): the thread's own mac_run row
 * redrawn every MAC_RUN_LIVE_MS with `preview: { kind: 'shell', output }`,
 * the last MAC_RUN_LIVE_TAIL_BYTES of output so far. The desktop and the
 * phone fold it onto the row the harness already wrote; the final tool
 * result carries the whole (capped) output and supersedes it.
 *
 * The row is the harness's: Claude names it (the CLI's `_meta
 * ["claudecode/toolUseId"]` on the MCP call), Codex does not (its MCP call
 * comes through app-mcp-bridge.mjs), so MacRunCalls watches the log for open
 * mac_run calls and a call without a name claims the open one whose argv,
 * command and cwd match, else the oldest unclaimed.
 */

/** The tool-call row a live view redraws. */
export interface LiveToolRef {
  callId: string
  name: string
  input: unknown
  display?: { app?: string; action?: string }
  parentCallId?: string
}

/** Claude's in-process tool name; the fallback face when the row is named but not yet seen. */
export const CLAUDE_MAC_RUN_NAME = 'mcp__mac__mac_run'
const MAC_RUN_NAME = /(^|[._])mac_run$/
/** Open calls kept per thread: a call that never got a result (a crash) ages out. */
const OPEN_PER_THREAD = 32

const runKey = (input: unknown): string => {
  const r = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  return JSON.stringify([r.argv ?? null, r.command ?? null, r.cwd ?? null])
}

/** The open mac_run calls per thread, from the persisted rows (sessions.onEvent). */
export class MacRunCalls {
  private readonly open = new Map<string, LiveToolRef[]>()
  private readonly claimed = new Map<string, Set<string>>()

  observe(row: EventRow): void {
    const e = row.event
    if (e.type === 'tool-call') {
      if (e.partial || !MAC_RUN_NAME.test(e.name)) return
      const list = this.open.get(row.sessionId) ?? []
      const ref: LiveToolRef = {
        callId: e.callId,
        name: e.name,
        input: e.input,
        ...(e.display ? { display: e.display } : {}),
        ...(e.parentCallId ? { parentCallId: e.parentCallId } : {})
      }
      const at = list.findIndex((c) => c.callId === e.callId)
      if (at >= 0) list[at] = ref
      else list.push(ref)
      while (list.length > OPEN_PER_THREAD) list.shift()
      this.open.set(row.sessionId, list)
      return
    }
    if (e.type === 'tool-result') {
      const list = this.open.get(row.sessionId)
      if (!list) return
      const left = list.filter((c) => c.callId !== e.callId)
      if (left.length) this.open.set(row.sessionId, left)
      else this.open.delete(row.sessionId)
      this.claimed.get(row.sessionId)?.delete(e.callId)
    }
  }

  /**
   * The row a run belongs to: the named one (seen, or its fallback face), else
   * the open unclaimed call with the same argv, command and cwd, else the
   * oldest open unclaimed call; null while the harness has not written one yet.
   */
  claim(sessionId: string, args: MacRunArgs, callId?: string): LiveToolRef | null {
    const list = this.open.get(sessionId) ?? []
    const taken = this.claimed.get(sessionId) ?? new Set<string>()
    let ref: LiveToolRef | null | undefined
    if (callId)
      ref = list.find((c) => c.callId === callId) ?? {
        callId,
        name: CLAUDE_MAC_RUN_NAME,
        input: args
      }
    else {
      const free = list.filter((c) => !taken.has(c.callId))
      const want = runKey(args)
      ref = free.find((c) => runKey(c.input) === want) ?? free[0] ?? null
    }
    if (!ref) return null
    taken.add(ref.callId)
    this.claimed.set(sessionId, taken)
    return ref
  }

  release(sessionId: string, callId: string): void {
    const taken = this.claimed.get(sessionId)
    if (!taken) return
    taken.delete(callId)
    if (!taken.size) this.claimed.delete(sessionId)
  }

  openCount(sessionId: string): number {
    return this.open.get(sessionId)?.length ?? 0
  }
}

export interface MacRunLiveDeps {
  /** sessions.append: a partial tool-call is broadcast, never stored. */
  emit: (sessionId: string, event: AgentEvent) => void
  calls: MacRunCalls
  intervalMs?: number
  tailBytes?: number
  now?: () => number
}

/** One run's view: feed it frames, close it when the reply is in. */
export interface LiveRun {
  progress: (frame: ProgressFrame) => void
  close: () => void
  /** Partial rows emitted so far. */
  readonly emitted: number
}

/** The live text: the newest `tailBytes` of output, with a first line counting what scrolled off. */
export class LiveTail {
  private text = ''
  private bytes = 0
  /** Bytes no longer shown (scrolled off here, or skipped on the Mac). */
  hidden = 0

  constructor(private readonly tailBytes: number = MAC_RUN_LIVE_TAIL_BYTES) {}

  add(chunk: string, skipped = 0): void {
    this.hidden += skipped
    this.text += chunk
    this.bytes += Buffer.byteLength(chunk)
    if (this.bytes <= this.tailBytes) return
    const buf = Buffer.from(this.text)
    let start = buf.length - this.tailBytes
    const nl = buf.indexOf(0x0a, start - 1)
    if (nl >= 0 && nl + 1 < buf.length) start = nl + 1
    while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
    this.hidden += start
    this.text = buf.subarray(start).toString('utf8')
    this.bytes = buf.length - start
  }

  get output(): string {
    return this.hidden ? `[… ${this.hidden} earlier bytes …]\n${this.text}` : this.text
  }

  get empty(): boolean {
    return !this.text && !this.hidden
  }
}

export class MacRunLive {
  private readonly intervalMs: number
  private readonly tailBytes: number
  private readonly now: () => number

  constructor(private readonly deps: MacRunLiveDeps) {
    this.intervalMs = deps.intervalMs ?? MAC_RUN_LIVE_MS
    this.tailBytes = deps.tailBytes ?? MAC_RUN_LIVE_TAIL_BYTES
    this.now = deps.now ?? Date.now
  }

  open(sessionId: string, args: MacRunArgs, callId?: string): LiveRun {
    const tail = new LiveTail(this.tailBytes)
    let ref: LiveToolRef | null = null
    let timer: NodeJS.Timeout | null = null
    let last = -Infinity
    let dirty = false
    let closed = false
    let emitted = 0
    const flush = (): void => {
      timer = null
      if (closed || !dirty) return
      ref ??= this.deps.calls.claim(sessionId, args, callId)
      // The harness has not written the row yet: look again a beat later.
      if (!ref) {
        timer = setTimeout(flush, this.intervalMs)
        timer.unref?.()
        return
      }
      dirty = false
      last = this.now()
      emitted++
      this.deps.emit(sessionId, {
        type: 'tool-call',
        callId: ref.callId,
        name: ref.name,
        input: ref.input,
        partial: true,
        ...(ref.display ? { display: ref.display } : {}),
        ...(ref.parentCallId ? { parentCallId: ref.parentCallId } : {}),
        preview: { kind: 'shell', output: tail.output }
      })
    }
    return {
      progress: (frame) => {
        if (closed) return
        tail.add(frame.chunk, frame.skipped)
        if (tail.empty) return
        dirty = true
        if (timer) return
        timer = setTimeout(flush, Math.max(0, last + this.intervalMs - this.now()))
        timer.unref?.()
      },
      close: () => {
        if (closed) return
        closed = true
        if (timer) clearTimeout(timer)
        timer = null
        if (ref) this.deps.calls.release(sessionId, ref.callId)
      },
      get emitted() {
        return emitted
      }
    }
  }
}
