/** A viewer may draw one frame and retain only the newest frame behind it. */
export const PREVIEW_STARVE_MS = 5_000
/**
 * A watcher takes no frame until it is `ready` (its start answer has gone
 * out: a frame before it would name a preview id the client does not know
 * yet, never be drawn and never be acked); until then the newest frame waits
 * in its pending slot.
 */
export class PreviewGate<F extends { seq: number }> {
  private readonly watchers = new Map<
    string,
    { send: (frame: F) => void; lastAck: number; ready: boolean; flight?: F; pending?: F }
  >()
  private latest: F | undefined
  private readonly withheld = new Set<number>()
  constructor(
    private readonly now: () => number,
    private readonly serviceAck: (seq: number) => void
  ) {}
  add(id: string, send: (frame: F) => void): void {
    this.watchers.set(id, { send, lastAck: this.now(), ready: false, pending: this.latest })
  }
  /** The watcher knows its id now: it gets the newest frame (which can wake a starved service once drawn). */
  ready(id: string): void {
    const w = this.watchers.get(id)
    if (!w || w.ready) return
    w.ready = true
    if (w.flight || !w.pending) return
    w.flight = w.pending
    w.pending = undefined
    w.send(w.flight)
  }
  remove(id: string): void {
    this.watchers.delete(id)
  }
  frame(frame: F, serviceSeq = frame.seq): void {
    if (
      !this.watchers.size ||
      [...this.watchers.values()].some((w) => this.now() - w.lastAck < PREVIEW_STARVE_MS)
    )
      this.serviceAck(serviceSeq)
    else this.withheld.add(serviceSeq)
    if (this.watchers.size) this.latest = frame
    for (const w of this.watchers.values()) {
      if (w.flight || !w.ready) w.pending = frame
      else {
        w.flight = frame
        w.send(frame)
      }
    }
  }
  ack(id: string, seq: number): void {
    const w = this.watchers.get(id)
    if (!w || w.flight?.seq !== seq) return
    w.lastAck = this.now()
    for (const held of this.withheld) this.serviceAck(held)
    this.withheld.clear()
    w.flight = w.pending
    w.pending = undefined
    if (w.flight) w.send(w.flight)
  }
  /** A service stream has its own sequence; old draws must not release new frames. */
  reset(): void {
    this.withheld.clear()
    this.latest = undefined
    for (const w of this.watchers.values()) {
      w.flight = undefined
      w.pending = undefined
      w.lastAck = this.now()
    }
  }
}
