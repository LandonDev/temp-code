import {
  MAC_RUN_HEAD_BYTES,
  MAC_RUN_PROGRESS_FRAME_BYTES,
  MAC_RUN_PROGRESS_MS,
  MAC_RUN_TAIL_BYTES
} from '@shared/contract-macbridge'

/**
 * Streaming over the Mac bridge's reverse RPC (docs/box.md "The Mac bridge",
 * "mac_run streams"). While a call runs on the Mac, its output crosses as
 *
 *   Mac → box  peer.progress { callId, seq, chunk, skipped? }   × n, then
 *   Mac → box  peer.reply { … }                                 the whole (capped) result
 *
 * on the same socket, so every frame lands before the reply. The pieces:
 *
 *  - HeadTailOutput (the Mac's runner): stdout and stderr in arrival order,
 *    kept whole up to the cap, past it the first MAC_RUN_HEAD_BYTES and the
 *    last MAC_RUN_TAIL_BYTES with a marker line counting what went between.
 *  - ProgressPacer (the Mac's runner): whole lines, at most one frame per
 *    MAC_RUN_PROGRESS_MS and MAC_RUN_PROGRESS_FRAME_BYTES per frame; a backlog
 *    keeps its newest lines (the live view is a view, the reply is the record).
 *  - progressSender (the Mac's servePeerCall): numbers the frames.
 *  - ProgressOrder (the box's PeerCalls): hands chunks on in seq order.
 */

export type OutputStream = 'stdout' | 'stderr'

const NL = 0x0a

/** The length of `buf` without an incomplete UTF-8 sequence at its end. */
export function utf8SafeEnd(buf: Buffer): number {
  const n = buf.length
  for (let back = 1; back <= Math.min(3, n); back++) {
    const b = buf[n - back]
    if ((b & 0xc0) === 0x80) continue // a continuation byte: keep looking for the lead
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1
    return need > back ? n - back : n
  }
  return n
}

/** The first index at or after `from` that starts a UTF-8 character. */
export function utf8SafeStart(buf: Buffer, from = 0): number {
  let i = from
  while (i < buf.length && i - from < 3 && (buf[i] & 0xc0) === 0x80) i++
  return i
}

const mib = (bytes: number): string => {
  const m = bytes / (1024 * 1024)
  return Number.isInteger(m) ? `${m} MiB` : `${Math.round(bytes / 1024)} KiB`
}

/** The line that stands in for a stream's dropped middle. */
export function droppedMarker(
  stream: OutputStream,
  dropped: number,
  headBytes: number,
  tailBytes: number
): string {
  return `\n[mac_run: ${dropped} bytes of ${stream} dropped here; the output passed ${mib(headBytes + tailBytes)}, so the first ${mib(headBytes)} and the last ${mib(tailBytes)} are kept]\n`
}

interface Piece {
  stream: OutputStream
  buf: Buffer
}

/**
 * A command's output as the result carries it. One budget for both streams in
 * arrival order: the head is the first `headBytes` of output, the tail the
 * newest `tailBytes`; what falls between is counted per stream. Memory stays
 * at head + tail however long the command talks.
 */
export class HeadTailOutput {
  private readonly head: Piece[] = []
  private headUsed = 0
  private tail: Piece[] = []
  private tailStart = 0
  private tailUsed = 0
  private readonly droppedBy: Record<OutputStream, number> = { stdout: 0, stderr: 0 }
  /** Every byte seen, kept or not. */
  total = 0

  constructor(
    readonly headBytes: number = MAC_RUN_HEAD_BYTES,
    readonly tailBytes: number = MAC_RUN_TAIL_BYTES
  ) {}

  push(stream: OutputStream, chunk: Buffer): void {
    if (!chunk.length) return
    this.total += chunk.length
    let rest = chunk
    const room = this.headBytes - this.headUsed
    if (room > 0) {
      const take = Math.min(room, rest.length)
      this.head.push({ stream, buf: rest.subarray(0, take) })
      this.headUsed += take
      rest = rest.subarray(take)
    }
    if (!rest.length) return
    this.tail.push({ stream, buf: rest })
    this.tailUsed += rest.length
    while (this.tailUsed > this.tailBytes) {
      const first = this.tail[this.tailStart]
      const over = this.tailUsed - this.tailBytes
      if (first.buf.length <= over) {
        this.tailStart++
        this.tailUsed -= first.buf.length
        this.droppedBy[first.stream] += first.buf.length
      } else {
        this.tail[this.tailStart] = { stream: first.stream, buf: first.buf.subarray(over) }
        this.tailUsed -= over
        this.droppedBy[first.stream] += over
      }
    }
    // Compact the ring now and then, so a chatty command's many small pieces stay O(1) each.
    if (this.tailStart > 1024 && this.tailStart * 2 > this.tail.length) {
      this.tail = this.tail.slice(this.tailStart)
      this.tailStart = 0
    }
  }

  get dropped(): number {
    return this.droppedBy.stdout + this.droppedBy.stderr
  }

  get truncated(): boolean {
    return this.dropped > 0
  }

  /** Bytes kept, both streams. */
  get kept(): number {
    return this.headUsed + this.tailUsed
  }

  /** One stream as text: whole, or its head, the marker and its tail. */
  text(stream: OutputStream): string {
    const pick = (pieces: Piece[], from = 0): Buffer =>
      Buffer.concat(
        pieces
          .slice(from)
          .filter((p) => p.stream === stream)
          .map((p) => p.buf)
      )
    const head = pick(this.head)
    const tail = pick(this.tail, this.tailStart)
    const dropped = this.droppedBy[stream]
    if (!dropped) return Buffer.concat([head, tail]).toString('utf8')
    return (
      head.subarray(0, utf8SafeEnd(head)).toString('utf8') +
      droppedMarker(stream, dropped, this.headBytes, this.tailBytes) +
      tail.subarray(utf8SafeStart(tail)).toString('utf8')
    )
  }
}

export interface ProgressPacerOptions {
  /** One frame: text made of whole lines (or a forced cut), and the bytes left out before it. */
  send: (chunk: string, skipped: number) => void
  intervalMs?: number
  frameBytes?: number
  /** A line with no newline yet goes out once it has waited this long (a prompt, a progress bar). */
  partialLineMs?: number
  now?: () => number
}

/**
 * Turns a command's raw output into progress frames: line-buffered per
 * stream (stdout and stderr never mix inside a line), whole lines in arrival
 * order, at most one frame per `intervalMs` and `frameBytes` per frame. A
 * backlog over a frame keeps its newest lines and counts the rest as skipped.
 * `end()` sends what is left in one last frame, at once.
 */
export class ProgressPacer {
  private readonly intervalMs: number
  private readonly frameBytes: number
  private readonly partialLineMs: number
  private readonly now: () => number
  private readonly partial: Record<OutputStream, Buffer> = {
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0)
  }
  private readonly partialSince: Record<OutputStream, number | null> = {
    stdout: null,
    stderr: null
  }
  private ready: Buffer[] = []
  private readyBytes = 0
  private skipped = 0
  private lastSent = -Infinity
  private timer: NodeJS.Timeout | null = null
  private timerDue = Infinity
  private ended = false
  /** Frames sent, for the log line and the tests. */
  frames = 0

  constructor(private readonly opts: ProgressPacerOptions) {
    this.intervalMs = opts.intervalMs ?? MAC_RUN_PROGRESS_MS
    this.frameBytes = opts.frameBytes ?? MAC_RUN_PROGRESS_FRAME_BYTES
    this.partialLineMs = opts.partialLineMs ?? 1_000
    this.now = opts.now ?? Date.now
  }

  push(stream: OutputStream, chunk: Buffer): void {
    if (this.ended || !chunk.length) return
    let buf = this.partial[stream].length ? Buffer.concat([this.partial[stream], chunk]) : chunk
    const nl = buf.lastIndexOf(NL)
    if (nl >= 0) {
      this.enqueue(buf.subarray(0, nl + 1))
      buf = buf.subarray(nl + 1)
    }
    // A line longer than a frame goes as it is, cut on a character.
    while (buf.length >= this.frameBytes) {
      const cut = utf8SafeEnd(buf.subarray(0, this.frameBytes)) || this.frameBytes
      this.enqueue(buf.subarray(0, cut))
      buf = buf.subarray(cut)
    }
    this.partial[stream] = buf
    if (!buf.length) this.partialSince[stream] = null
    else this.partialSince[stream] ??= this.now()
    this.schedule()
  }

  private enqueue(buf: Buffer): void {
    if (!buf.length) return
    this.ready.push(buf)
    this.readyBytes += buf.length
    // Never hold more than two frames' worth between flushes: older lines become skipped.
    if (this.readyBytes > 2 * this.frameBytes) this.trimTo(this.frameBytes)
  }

  /** Keep the newest `limit` bytes of the backlog, starting on a line (or a character) boundary. */
  private trimTo(limit: number): void {
    const all = this.ready.length === 1 ? this.ready[0] : Buffer.concat(this.ready)
    if (all.length <= limit) return
    const cut = all.length - limit
    const nl = all.indexOf(NL, cut - 1)
    const start = nl >= 0 && nl + 1 < all.length ? nl + 1 : utf8SafeStart(all, cut)
    this.skipped += start
    const kept = all.subarray(start)
    this.ready = kept.length ? [kept] : []
    this.readyBytes = kept.length
  }

  private schedule(): void {
    if (this.ended) return
    const now = this.now()
    let delay = Math.max(0, this.lastSent + this.intervalMs - now)
    if (!this.readyBytes) {
      // Only a partial line waits: come back when it is old enough to go.
      const since = Math.min(
        ...(['stdout', 'stderr'] as const)
          .map((s) => this.partialSince[s])
          .filter((t): t is number => t !== null)
      )
      if (!Number.isFinite(since)) return
      delay = Math.max(delay, since + this.partialLineMs - now)
    }
    // A timer already set for as soon (or sooner) stands; one set for a waiting partial line gives way to whole lines.
    if (this.timer && this.timerDue <= now + delay) return
    if (this.timer) clearTimeout(this.timer)
    this.timerDue = now + delay
    this.timer = setTimeout(() => this.flush(), delay)
    this.timer.unref?.()
  }

  /** Lines with no newline that have waited long enough join the backlog (cut on a character). */
  private takeStalePartialLines(force: boolean): void {
    const now = this.now()
    for (const s of ['stdout', 'stderr'] as const) {
      const since = this.partialSince[s]
      const buf = this.partial[s]
      if (!buf.length || since === null) continue
      if (!force && now - since < this.partialLineMs) continue
      const end = force ? buf.length : utf8SafeEnd(buf)
      if (!end) continue
      this.enqueue(buf.subarray(0, end))
      this.partial[s] = buf.subarray(end)
      this.partialSince[s] = this.partial[s].length ? now : null
    }
  }

  private flush(): void {
    this.timer = null
    this.timerDue = Infinity
    if (this.ended) return
    this.takeStalePartialLines(false)
    if (this.readyBytes) this.sendFrame()
    this.schedule()
  }

  private sendFrame(): void {
    this.trimTo(this.frameBytes)
    if (!this.readyBytes) return
    const chunk = (this.ready.length === 1 ? this.ready[0] : Buffer.concat(this.ready)).toString(
      'utf8'
    )
    const skipped = this.skipped
    this.ready = []
    this.readyBytes = 0
    this.skipped = 0
    this.lastSent = this.now()
    this.frames++
    this.opts.send(chunk, skipped)
  }

  /** The command is done: what is left goes now, in one frame; nothing after. */
  end(): void {
    if (this.ended) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.takeStalePartialLines(true)
    this.sendFrame()
    this.ended = true
  }
}

/** The Mac side: number one call's frames and send them; a refused frame is logged once, never thrown. */
export function progressSender(
  request: (method: string, params?: unknown) => Promise<unknown>,
  callId: string,
  log: (line: string) => void = () => {}
): (chunk: string, skipped?: number) => void {
  let seq = 0
  let complained = false
  return (chunk, skipped = 0) => {
    const params = { callId, seq: seq++, chunk, ...(skipped ? { skipped } : {}) }
    request('peer.progress', params).catch((err: unknown) => {
      if (complained) return
      complained = true
      log(`progress for ${callId} not taken: ${err instanceof Error ? err.message : String(err)}`)
    })
  }
}

/** One frame as the box hands it on. */
export interface ProgressFrame {
  seq: number
  chunk: string
  skipped: number
}

/**
 * The box side: frames out of order wait (up to `maxHeld`) and go on in seq
 * order; a repeat or an older seq is dropped. A gap that never fills is
 * skipped once more than `maxHeld` frames are waiting behind it.
 */
export class ProgressOrder {
  private next = 0
  private readonly held = new Map<number, ProgressFrame>()

  constructor(
    private readonly deliver: (frame: ProgressFrame) => void,
    private readonly maxHeld = 64
  ) {}

  take(frame: ProgressFrame): void {
    if (frame.seq < this.next || this.held.has(frame.seq)) return
    this.held.set(frame.seq, frame)
    if (this.held.size > this.maxHeld) this.next = Math.min(...this.held.keys())
    for (let f = this.held.get(this.next); f; f = this.held.get(this.next)) {
      this.held.delete(this.next)
      this.next++
      this.deliver(f)
    }
  }
}
