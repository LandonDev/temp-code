import type { IdleSource } from './attention'

/**
 * The person's idle time with the app's own input taken out (docs/
 * computer-protocol.md "Tier scheduling"). macOS counts an event posted at
 * the HID tap as input, so every `session` step the computer service runs
 * would read as the person coming back: the scheduler would hold the thread's
 * next session step for two minutes, and attention.ts would flip to present.
 *
 * The service's person watch is armed for exactly the life of each session
 * step and stops it on any input it did not post, so a step that ran to its
 * end is a span the host may take out, and only the span: the gaps between a
 * batch's steps and a call's closing wait have no watch, and input there
 * stays the person's. While a call is out (`beginOwn` until `end`) every
 * input after its start reads as the app's, since its spans are not known
 * yet; `end` replaces that with the spans alone.
 */

/** One session step that ran to its end, from its SessionChange. */
export interface OwnSpan {
  /** epoch ms: the person watch armed */
  armedAt: number
  /** epoch ms: the step's last posted event */
  lastInputAt: number
  /** the system's idle time when the watch armed: the person's last input before the span is armedAt − idleAtArmMs */
  idleAtArmMs: number
}

export interface OwnInputWindow {
  /** The call's spans: its `ok` session steps' changes. An interrupted call passes none. */
  end(spans: OwnSpan[]): void
}

export interface PersonIdleSource extends IdleSource {
  /** Before a call that may post at the session tier: input after this reads as the app's until end(). */
  beginOwn(): OwnInputWindow
}

/** The raw idle time is whole seconds, so a read can place the step's last event up to a second late. */
export const OWN_INPUT_SLACK_MS = 1_000
export const OWN_SPANS_MAX = 64
export const OWN_SPAN_KEEP_MS = 3_600_000

interface OpenCall {
  startedAt: number
  /** the person's last input when the call began */
  personAt: number
}

export class PersonIdle implements PersonIdleSource {
  private spans: OwnSpan[] = []
  private readonly open = new Set<OpenCall>()

  constructor(
    private readonly raw: IdleSource,
    private readonly now: () => number = Date.now
  ) {}

  /** Whole seconds since the person's last input. */
  getSystemIdleTime(): number {
    const now = this.now()
    return Math.max(0, Math.floor((now - this.personAt(now)) / 1000))
  }

  beginOwn(): OwnInputWindow {
    const now = this.now()
    const call: OpenCall = { startedAt: now, personAt: this.personAt(now) }
    this.open.add(call)
    let ended = false
    return {
      end: (spans) => {
        if (ended) return
        ended = true
        this.open.delete(call)
        this.keep(spans)
      }
    }
  }

  /** Epoch ms of the person's last input: the raw reading, unless it falls in an open call or a kept span. */
  private personAt(now: number): number {
    let at = now - Math.max(0, Math.floor(this.raw.getSystemIdleTime())) * 1000
    let earliest: OpenCall | null = null
    for (const call of this.open) if (at >= call.startedAt && (!earliest || call.startedAt < earliest.startedAt)) earliest = call
    if (earliest) at = earliest.personAt
    // spans chain: the person's last input before one span may fall inside an earlier one
    for (let hops = 0; hops <= this.spans.length; hops++) {
      const span = this.spans.find((s) => s.armedAt <= at && at < s.lastInputAt + OWN_INPUT_SLACK_MS)
      if (!span) break
      at = span.armedAt - span.idleAtArmMs
    }
    return at
  }

  private keep(spans: OwnSpan[]): void {
    const now = this.now()
    const valid = spans.filter(
      (s) =>
        Number.isFinite(s.armedAt) &&
        Number.isFinite(s.lastInputAt) &&
        Number.isFinite(s.idleAtArmMs) &&
        s.armedAt <= s.lastInputAt &&
        s.idleAtArmMs >= 0
    )
    this.spans = [...this.spans, ...valid]
      .filter((s) => s.lastInputAt >= now - OWN_SPAN_KEEP_MS)
      .sort((a, b) => a.armedAt - b.armedAt)
      .slice(-OWN_SPANS_MAX)
  }
}
