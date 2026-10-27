/**
 * The parse worker's queue (markdown.worker.ts wires it to `self`). A
 * request is queued, not parsed in its own message handler, and the queue
 * yields between parses, so a `{ cancel: id }` the client sends after the
 * request still lands before its parse: a row that left (a thread passed
 * through on the way to another, a row past its deadline) costs the
 * worker nothing. A cancelled request is never answered.
 */
export type WorkerMessage = { id: number; text: string } | { cancel: number };

export interface WorkerQueue {
  receive(message: WorkerMessage): void;
}

export function createWorkerQueue<A>(opts: {
  /** Parse one text into its answer. */
  parse: (text: string) => A;
  /** Send an answer back. */
  post: (answer: { id: number; blocks: A }) => void;
  /** Run `fn` in a later task, after messages already waiting. */
  schedule: (fn: () => void) => void;
}): WorkerQueue {
  const queue: { id: number; text: string }[] = [];
  const cancelled = new Set<number>();
  let scheduled = false;
  const step = (): void => {
    scheduled = false;
    const next = queue.shift();
    if (!next) return;
    if (cancelled.delete(next.id)) {
      // Nothing to parse; go on to the next at once.
      step();
      return;
    }
    opts.post({ id: next.id, blocks: opts.parse(next.text) });
    if (queue.length > 0) {
      scheduled = true;
      opts.schedule(step);
    }
  };
  return {
    receive(message) {
      if ("cancel" in message) {
        // Only an id still queued can be skipped; one already answered is gone.
        if (queue.some((q) => q.id === message.cancel)) cancelled.add(message.cancel);
        return;
      }
      queue.push(message);
      if (!scheduled) {
        scheduled = true;
        opts.schedule(step);
      }
    },
  };
}
