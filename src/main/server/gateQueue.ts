/**
 * The gate queue: one per host, every gate run on it in turn (CLAUDE.md
 * "Master threads"). A batch child's typecheck in merge_branch, a thread
 * outside a batch's commit tier, and the batch's own gate and release all
 * run through `run`, so two of them never share the box's cores, and a
 * caller waiting its turn hears where it stands. FIFO; a run that throws
 * answers its caller and never holds the next one back.
 */

export interface GateWait {
  /** 1 = next after the running one */
  position: number
  /** the running label first, then those queued ahead */
  ahead: string[]
}

interface Entry {
  label: string
  onWait?: (w: GateWait) => void
}

export class GateQueue {
  private running: Entry | null = null
  private readonly waiting: Entry[] = []
  private tail: Promise<void> = Promise.resolve()

  /** Labels on the queue: the running one first, then the waiters in order. */
  get labels(): string[] {
    return [...(this.running ? [this.running.label] : []), ...this.waiting.map((e) => e.label)]
  }

  get busy(): boolean {
    return this.running !== null || this.waiting.length > 0
  }

  /** Runs `fn` when every earlier run has finished. `onWait` hears the
   *  position at enqueue when the queue is busy and again each time a run
   *  ahead finishes. */
  run<T>(label: string, fn: () => Promise<T>, onWait?: (w: GateWait) => void): Promise<T> {
    const entry: Entry = { label, onWait }
    this.waiting.push(entry)
    this.report(entry)
    const turn = this.tail.then(async () => {
      const i = this.waiting.indexOf(entry)
      if (i >= 0) this.waiting.splice(i, 1)
      this.running = entry
      try {
        return await fn()
      } finally {
        this.running = null
        for (const w of this.waiting) this.report(w)
      }
    })
    this.tail = turn.then(
      () => undefined,
      () => undefined
    )
    return turn
  }

  private report(entry: Entry): void {
    if (!entry.onWait) return
    const entries = [...(this.running ? [this.running] : []), ...this.waiting]
    const position = entries.indexOf(entry)
    if (position <= 0) return
    entry.onWait({ position, ahead: entries.slice(0, position).map((e) => e.label) })
  }
}

/** This host's queue (one process is one host). */
let current = new GateQueue()
export function gateQueue(): GateQueue {
  return current
}
/** Tests only. */
export function setGateQueue(q: GateQueue): void {
  current = q
}
