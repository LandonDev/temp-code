import type { ServerPush } from "@server/shared/contract";
import type { WireProfile } from "@server/shared/wire";
import { ConnectionLostError, READ_TIMEOUT_MS, SLOW_MS, TimeoutError, type RequestOptions, type Transport } from "./transport";

/** Waits between retries of a failed load or read: 1, 2, 4, 8, then 15 s. */
export const RETRY_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;

/** The wait before retry `attempt` (0-based); past the list it stays at the last. */
export function retryDelay(attempt: number): number {
  return RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)];
}

/** Reads that change nothing on the host: the link asks again when the
 *  socket drops or the answer is late. Writes are never replayed. */
export const SAFE_READS: ReadonlySet<string> = new Set([
  "session.events",
  "session.head",
  "session.tail",
  "session.list",
  "session.context",
  "notes.get",
  "batch.get",
  "batch.board",
  "fs.read",
]);

/** A failure of the socket rather than an answer from the host. */
export function isConnectionFailure(e: unknown): boolean {
  return e instanceof TimeoutError || e instanceof ConnectionLostError;
}

export type LinkRequestOptions = RequestOptions & {
  /** Ask again on a dropped socket or a timeout; defaults to true for SAFE_READS. */
  retry?: boolean;
};

/** How the host has been answering: `slowSince` is set by an answer later
 *  than SLOW_MS or a timeout of an ordinary request (a read or a send; a
 *  push or a search may take long on a healthy host) and cleared by the
 *  next answer inside SLOW_MS. */
export type LinkHealth = { slowSince: number | null; lastAnswerMs: number | null };

/**
 * What a store holds for one environment: a request path, the push
 * stream, and `onOpen` for every replacement session. The supervisor
 * swaps the transport behind it; the stores never see the swap except as
 * one `onOpen`, on which they re-list and re-subscribe.
 */
export type Link = {
  readonly environmentId: string;
  readonly connected: boolean;
  /** The wire profile the live socket opened with. */
  readonly profile: WireProfile;
  request<T>(method: string, params?: unknown, options?: LinkRequestOptions): Promise<T>;
  onPush(listener: (push: ServerPush) => void): () => void;
  onOpen(listener: () => void): () => void;
  onClose(listener: () => void): () => void;
};

export class EnvLink implements Link {
  private session: Transport | null = null;
  private detach: (() => void)[] = [];
  private pushListeners = new Set<(push: ServerPush) => void>();
  private openListeners = new Set<() => void>();
  private closeListeners = new Set<() => void>();
  private healthListeners = new Set<() => void>();
  private healthState: LinkHealth = { slowSince: null, lastAnswerMs: null };

  constructor(
    readonly environmentId: string,
    private readonly defaultProfile: WireProfile,
  ) {}

  get connected(): boolean {
    return this.session?.state === "open";
  }

  get profile(): WireProfile {
    return this.session?.profile ?? this.defaultProfile;
  }

  /** The transport behind the link, for the stall log and devtools. */
  get transport(): Transport | null {
    return this.session;
  }

  get health(): LinkHealth {
    return this.healthState;
  }

  /** Fires when the link turns slow or stops being slow. */
  onHealth(listener: () => void): () => void {
    this.healthListeners.add(listener);
    return () => this.healthListeners.delete(listener);
  }

  /**
   * One request on the live socket. A safe read that fails for the socket's
   * sake (it dropped, it was down, the answer was late) is asked again after
   * 1, 2, 4, 8 and 15 s, at once when a new socket opens first; then the
   * last failure stands. A host's own refusal is never retried.
   */
  async request<T>(method: string, params?: unknown, options: LinkRequestOptions = {}): Promise<T> {
    const retry = options.retry ?? SAFE_READS.has(method);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once<T>(method, params, options);
      } catch (e) {
        if (!retry || !isConnectionFailure(e) || attempt >= RETRY_BACKOFF_MS.length) throw e;
        await this.nextChance(retryDelay(attempt));
      }
    }
  }

  private once<T>(method: string, params: unknown, options: RequestOptions): Promise<T> {
    const session = this.session;
    if (!session || session.state !== "open") return Promise.reject(new ConnectionLostError("not connected"));
    return session.request<T>(method, params, {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.lane ? { lane: options.lane } : {}),
    });
  }

  /** The backoff, cut short by a new socket. */
  private nextChance(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        off();
        resolve();
      };
      const timer = setTimeout(done, ms);
      const off = this.onOpen(done);
    });
  }

  pendingMethods(): string[] {
    return this.session?.pendingMethods() ?? [];
  }

  onPush(listener: (push: ServerPush) => void): () => void {
    this.pushListeners.add(listener);
    return () => this.pushListeners.delete(listener);
  }

  onOpen(listener: () => void): () => void {
    this.openListeners.add(listener);
    return () => this.openListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** The supervisor's hook: a new live session, or none. */
  setSession(session: Transport | null): void {
    if (session === this.session) return;
    for (const off of this.detach) off();
    this.detach = [];
    const had = this.session !== null;
    this.session = session;
    if (!session) {
      if (had) for (const l of this.closeListeners) l();
      return;
    }
    this.detach = [
      session.onPush((push) => {
        for (const l of this.pushListeners) l(push);
      }),
      session.onAnswer((ms, timedOut, timeoutMs) => this.noteAnswer(ms, timedOut, timeoutMs)),
      session.onClose(() => {
        if (this.session !== session) return;
        this.session = null;
        this.detach = [];
        for (const l of this.closeListeners) l();
      }),
    ];
    for (const l of [...this.openListeners]) l();
  }

  private noteAnswer(ms: number, timedOut: boolean, timeoutMs: number): void {
    const late = timedOut || ms > SLOW_MS;
    // A long method's late answer says nothing about the host; its quick one does.
    if (late && timeoutMs > READ_TIMEOUT_MS) return;
    const wasSlow = this.healthState.slowSince !== null;
    this.healthState = {
      slowSince: late ? (this.healthState.slowSince ?? Date.now()) : null,
      lastAnswerMs: ms,
    };
    if (late !== wasSlow) for (const l of this.healthListeners) l();
  }
}
