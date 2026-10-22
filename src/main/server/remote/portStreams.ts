import type { Socket } from 'node:net'
import { PORT_CHUNK_BYTES, PORT_HIGH_WATER, PORT_LOW_WATER, PORT_WINDOW_FRAMES } from '@shared/contract-ports'

/**
 * One TCP connection carried as frames over the peer link (docs/box.md "Dev
 * servers on the box"), the same on both ends:
 *
 *  - LinkStream.pump reads the local socket into numbered data frames
 *    (PORT_CHUNK_BYTES each at most). It pauses the socket while the link
 *    holds more than PORT_HIGH_WATER unsent or, when a send answers (the Mac's
 *    requests), while PORT_WINDOW_FRAMES are unanswered, and resumes below
 *    PORT_LOW_WATER and half the window. The socket ending sends the close
 *    frame with the count of data frames before it.
 *  - LinkStream.deliver writes the other side's frames in seq order (a frame
 *    that arrives early waits for the gap), and closes the socket once the
 *    close frame's count has been written.
 */

export interface StreamLink {
  /** Send one data frame; a promise is its ack (the Mac's request), void is fire-and-forget (the box's push). */
  data: (seq: number, base64: string) => Promise<unknown> | void
  close: (seq: number, error?: string) => void
  /** The link's unsent bytes. */
  buffered: () => number
}

/** How often a paused socket checks the link again. */
const RESUME_POLL_MS = 20
/** Frames that may wait for a gap before the stream is given up. */
const MAX_EARLY = 1024

export class LinkStream {
  private sent = 0
  private unacked = 0
  private paused = false
  private poll: NodeJS.Timeout | null = null
  private expected = 0
  private readonly early = new Map<number, Buffer>()
  private closeAt: number | null = null
  private closed = false
  private localEnded = false
  /** Bytes each way, for the row's numbers and the proof. */
  bytesIn = 0
  bytesOut = 0

  constructor(
    readonly id: string,
    private readonly socket: Socket,
    private readonly link: StreamLink,
    private readonly onDone: (id: string) => void = () => {}
  ) {}

  /** Start reading the local socket onto the link. */
  pump(): void {
    const s = this.socket
    s.on('data', (buf: Buffer) => {
      for (let i = 0; i < buf.length; i += PORT_CHUNK_BYTES) this.send(buf.subarray(i, i + PORT_CHUNK_BYTES))
      this.check()
    })
    s.on('end', () => {
      this.localEnded = true
      if (!this.closed) this.link.close(this.sent)
    })
    s.on('error', (err) => this.finish(err.message, true))
    s.on('close', () => this.finish(undefined, !this.localEnded))
    if (s.isPaused()) s.resume()
  }

  private send(chunk: Buffer): void {
    if (this.closed) return
    this.bytesOut += chunk.length
    const ack = this.link.data(this.sent++, chunk.toString('base64'))
    if (ack) {
      this.unacked++
      ack.then(
        () => {
          this.unacked--
          this.check()
        },
        (err: unknown) => this.finish(err instanceof Error ? err.message : String(err), true)
      )
    }
  }

  /** Pause or resume the socket against the link's buffer and the unanswered frames. */
  private check(): void {
    if (this.closed) return
    const full = this.link.buffered() > PORT_HIGH_WATER || this.unacked >= PORT_WINDOW_FRAMES
    const clear = this.link.buffered() < PORT_LOW_WATER && this.unacked < PORT_WINDOW_FRAMES / 2
    if (!this.paused && full) {
      this.paused = true
      this.socket.pause()
    } else if (this.paused && clear) {
      this.paused = false
      if (this.poll) clearTimeout(this.poll)
      this.poll = null
      this.socket.resume()
    }
    if (this.paused && !this.poll) {
      this.poll = setTimeout(() => {
        this.poll = null
        this.check()
      }, RESUME_POLL_MS)
      this.poll.unref?.()
    }
  }

  get isPaused(): boolean {
    return this.paused
  }

  /** A data frame from the other side. */
  deliver(seq: number, base64: string): void {
    if (this.closed) return
    if (seq < this.expected) return
    this.early.set(seq, Buffer.from(base64, 'base64'))
    if (this.early.size > MAX_EARLY) return this.finish('too many frames out of order', true)
    for (let next = this.early.get(this.expected); next; next = this.early.get(this.expected)) {
      this.early.delete(this.expected++)
      this.bytesIn += next.length
      this.socket.write(next)
    }
    this.maybeEnd()
  }

  /** The other side ended after `seq` data frames. */
  remoteClose(seq: number, error?: string): void {
    if (this.closed) return
    if (error) return this.finish(error, false)
    this.closeAt = seq
    this.maybeEnd()
  }

  private maybeEnd(): void {
    if (this.closeAt === null || this.expected < this.closeAt) return
    this.closeAt = null
    // Our own side may still talk (a half-close); the socket's end tells the other side in turn.
    this.socket.end()
  }

  /** Tear the stream down now; `tell` sends the other side a close with the reason. */
  finish(error?: string, tell = false): void {
    if (this.closed) return
    this.closed = true
    if (this.poll) clearTimeout(this.poll)
    this.poll = null
    if (tell) this.link.close(this.sent, error ?? 'closed')
    if (!this.socket.destroyed) this.socket.destroy()
    this.onDone(this.id)
  }
}
