/**
 * The launch gate's one judgement in scripts/e2e-tc-computer.ts: whether the Mac's last input was the
 * person's or the proof's own. The proof's process-tier events move the Mac's idle time as a hand
 * would (`HIDIdleTime` and the HID system's own count alike, measured 2026-11-09), so an input time is
 * the proof's only inside a span of one of its posting calls, or within `marginMs` of that call's
 * answer, by which time every event it posted is out. Spans never meet: a posting call goes out only
 * once the watch has had a whole interval with nothing masked (`clearAt`), so input that keeps going
 * across calls is always read in a gap.
 */
export interface Span {
  from: number
  to: number | null
}

export class OwnInput {
  readonly spans: Span[] = []

  constructor(readonly marginMs = 500) {}

  open(now: number): Span {
    const span = { from: now, to: null }
    this.spans.push(span)
    return span
  }

  /** The input at `at` may be the proof's own. */
  covers(at: number): boolean {
    return this.spans.some((s) => at >= s.from - 100 && at <= (s.to ?? Infinity) + this.marginMs)
  }

  /**
   * When the next posting call may go out: one unmasked watch interval after the last span's margin; at
   * once after none, or while the last is still out (the proof's calls go one at a time).
   */
  clearAt(intervalMs: number): number {
    const last = this.spans.at(-1)
    if (!last || last.to === null) return 0
    return last.to + this.marginMs + intervalMs
  }
}

/** A reading of `idleSeconds` at `now` shows the person's input since `since`. */
export function personSince(now: number, idleSeconds: number, since: number, own: OwnInput): boolean {
  const lastInput = now - idleSeconds * 1_000
  return lastInput > since && !own.covers(lastInput)
}
