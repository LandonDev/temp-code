import type { EventRow } from "@server/shared/events";
import type { EventsPage } from "@server/shared/wire";
import type { Link } from "./link";

/**
 * What the owner of one transcript gives the subscription set: where its
 * fold is, and how to take a page. `page.reset` is D2's rule: the gap
 * outgrew the budget and the host sent a fresh tail, so the owner throws
 * its fold away before folding the rows.
 */
export type SubscriptionHandlers = {
  /** The highest seq folded so far; the resume asks for what follows it. */
  cursor(): number;
  /** A fetch is in flight: hold live pushes until `end`. */
  begin?(): void;
  page(page: EventsPage): void;
  end?(): void;
  /** `session.subscribe` was refused: the session is gone from the host. */
  gone?(reason: string): void;
};

/** Older sockets answer `session.events` with the bare row array. */
export function asPage(result: EventRow[] | EventsPage, tailFirst: boolean): EventsPage {
  if (Array.isArray(result)) return { rows: result, moreBefore: false, moreAfter: false, reset: tailFirst };
  return result;
}

export const RESUME_CONCURRENCY = 4;

/**
 * The durable `session.subscribe` set of one environment. A subscription
 * belongs to the socket that made it, so on every replacement session
 * (`link.onOpen`) the set forgets what was subscribed and `resumeAll()`
 * re-subscribes each session and resumes it from its owner's cursor with
 * `afterSeq`, a few at a time. The owner (the session store) decides what
 * is in the set: it adds a transcript when it loads one and removes it when
 * it unloads one, so a reconnect never replays transcripts nobody is looking at.
 */
export class Subscriptions {
  private handlers = new Map<string, SubscriptionHandlers>();
  /** Session ids subscribed on the CURRENT socket. */
  private live = new Set<string>();
  private inFlight = new Map<string, Promise<EventsPage>>();
  private detach: (() => void)[];

  constructor(
    readonly link: Link,
    private readonly concurrency = RESUME_CONCURRENCY,
  ) {
    this.detach = [
      link.onOpen(() => this.live.clear()),
      link.onClose(() => this.live.clear()),
    ];
  }

  dispose(): void {
    for (const off of this.detach) off();
    this.detach = [];
    this.handlers.clear();
    this.live.clear();
  }

  has(sessionId: string): boolean {
    return this.handlers.has(sessionId);
  }

  ids(): string[] {
    return [...this.handlers.keys()];
  }

  /** True when the current socket carries this session's pushes. */
  isLive(sessionId: string): boolean {
    return this.live.has(sessionId) && this.link.connected;
  }

  add(sessionId: string, handlers: SubscriptionHandlers): void {
    this.handlers.set(sessionId, handlers);
  }

  /** Leave the set; the socket is told when it is up. */
  remove(sessionId: string): void {
    this.handlers.delete(sessionId);
    if (this.live.delete(sessionId) && this.link.connected)
      void this.link.request("session.unsubscribe", { sessionId }).catch(() => undefined);
  }

  /**
   * Subscribe on the current socket if not yet, then fetch what follows the
   * owner's cursor (`tail` for a cold open). The page is handed to the owner
   * and returned; a second call while one is in flight joins it.
   */
  resume(sessionId: string, options: { tail?: number } = {}): Promise<EventsPage> {
    const pending = this.inFlight.get(sessionId);
    if (pending) return pending;
    const handlers = this.handlers.get(sessionId);
    if (!handlers) return Promise.reject(new Error(`not subscribed: ${sessionId}`));
    const run = (async (): Promise<EventsPage> => {
      handlers.begin?.();
      try {
        if (!this.live.has(sessionId)) {
          try {
            await this.link.request("session.subscribe", { sessionId });
          } catch (err) {
            if (this.handlers.get(sessionId) === handlers)
              handlers.gone?.(err instanceof Error ? err.message : String(err));
            throw err;
          }
          this.live.add(sessionId);
        }
        const afterSeq = handlers.cursor();
        const tailFirst = options.tail !== undefined && afterSeq === 0;
        const result = await this.link.request<EventRow[] | EventsPage>("session.events", {
          sessionId,
          afterSeq,
          ...(tailFirst ? { tail: options.tail } : {}),
        });
        const page = asPage(result, tailFirst);
        if (this.handlers.get(sessionId) === handlers) handlers.page(page);
        return page;
      } finally {
        handlers.end?.();
      }
    })().finally(() => {
      this.inFlight.delete(sessionId);
    });
    this.inFlight.set(sessionId, run);
    return run;
  }

  /** After a replacement session: every member subscribes and resumes again. */
  async resumeAll(): Promise<void> {
    const ids = this.ids();
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < ids.length) {
        const id = ids[next++];
        if (!this.handlers.has(id)) continue;
        await this.resume(id).catch(() => undefined);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, ids.length) }, worker));
  }
}
