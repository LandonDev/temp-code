/**
 * One span per `session.send`, from the RPC's arrival to the first content
 * the harness produced: a stalls.log line that says WHERE a slow send spent
 * its time. The phases, as ms from `accepted`:
 *
 *   accepted       the RPC arrived (sessions.ts send())
 *   prepared       attachments, thread references and digests resolved
 *   handle         the driver handle: `live` (one was up), else the CLI's
 *                  own word, `warm` (adopted) or `cold` (spawned)
 *   delivered      handle.send returned (the text is in the harness)
 *   init           the harness's own init (claude's system/init, codex's
 *                  turn/started)
 *   first-message  any message back from the harness
 *   first-content  an assistant text delta or a tool call
 *
 * The line is written once per span: when `first-content` lands, or
 * SEND_SPAN_DEADLINE_MS after `accepted`, whichever first; a phase never
 * reached reads `-`. A new send on the same session flushes the span that
 * was open (two sends never share one), and a send the scheduler queued is
 * dropped without a line.
 */
export type SendPhase = 'accepted' | 'prepared' | 'handle' | 'delivered' | 'init' | 'first-message' | 'first-content'

export const SEND_PHASES: readonly SendPhase[] = ['accepted', 'prepared', 'handle', 'delivered', 'init', 'first-message', 'first-content']

export const SEND_SPAN_DEADLINE_MS = 15_000

interface Span {
  startedAt: number
  at: Partial<Record<SendPhase, number>>
  note: Partial<Record<SendPhase, string>>
  timer: unknown
}

export interface SendSpanOptions {
  /** Where the line goes (stalls.ts recordSendSpan). */
  write: (line: string) => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  deadlineMs?: number
}

const defaultSetTimer = (fn: () => void, ms: number): unknown => {
  const t = setTimeout(fn, ms)
  t.unref?.()
  return t
}

export class SendSpans {
  private readonly spans = new Map<string, Span>()
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly deadlineMs: number

  constructor(private readonly options: SendSpanOptions) {
    this.now = options.now ?? (() => Date.now())
    this.setTimer = options.setTimer ?? defaultSetTimer
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout))
    this.deadlineMs = options.deadlineMs ?? SEND_SPAN_DEADLINE_MS
  }

  /** The RPC arrived: a span opens; one still open on the session is flushed first. */
  begin(sessionId: string): void {
    this.flush(sessionId)
    const startedAt = this.now()
    const span: Span = { startedAt, at: { accepted: 0 }, note: {}, timer: null }
    span.timer = this.setTimer(() => this.flush(sessionId), this.deadlineMs)
    this.spans.set(sessionId, span)
  }

  /** A phase landed. The first mark of a phase sets its time; a note (the
   *  handle's `warm`/`cold`/`live`) is taken whenever given. Nothing without a span. */
  mark(sessionId: string, phase: SendPhase, note?: string): void {
    const span = this.spans.get(sessionId)
    if (!span) return
    if (span.at[phase] === undefined) span.at[phase] = this.now() - span.startedAt
    if (note) span.note[phase] = note
    if (phase === 'first-content') this.flush(sessionId)
  }

  /** The send never reached a harness (queued, held back): no line. */
  drop(sessionId: string): void {
    const span = this.spans.get(sessionId)
    if (!span) return
    this.clearTimer(span.timer)
    this.spans.delete(sessionId)
  }

  /** Write the span's line now (the deadline, first content, or a new send on the session). */
  flush(sessionId: string): void {
    const span = this.spans.get(sessionId)
    if (!span) return
    this.clearTimer(span.timer)
    this.spans.delete(sessionId)
    this.options.write(formatSpan(sessionId, span.at, span.note))
  }

  /** Open spans, for a test. */
  open(): string[] {
    return [...this.spans.keys()]
  }
}

/** `send session=<id> accepted=0 prepared=12 handle=340(warm) … first-content=2100`; a missing phase reads `-`. */
export function formatSpan(sessionId: string, at: Partial<Record<SendPhase, number>>, note: Partial<Record<SendPhase, string>> = {}): string {
  const fields = SEND_PHASES.map((phase) => {
    const ms = at[phase]
    const value = ms === undefined ? '-' : String(Math.round(ms))
    const tag = note[phase]
    return `${phase}=${value}${tag ? `(${tag})` : ''}`
  })
  return `send session=${sessionId} ${fields.join(' ')}`
}
