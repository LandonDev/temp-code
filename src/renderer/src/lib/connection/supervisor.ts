import type { WireProfile } from "@server/shared/wire";
import { Transport } from "./transport";
import {
  IDLE_STATUS,
  isUnauthorizedMessage,
  type CloseReason,
  type Environment,
  type EnvironmentStatus,
  type Hello,
  type Route,
  type TransportState,
} from "./types";

/** Timers and randomness, injectable so tests run on fake time. */
export type Clock = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  random(): number;
};

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  random: () => Math.random(),
};

export type Backoff = { baseMs: number; capMs: number; resetAfterMs: number; jitter: number };

/** 1 s doubling to a 5 min cap, ±25 % jitter, reset only after 30 s up. */
export const BACKOFF: Backoff = { baseMs: 1_000, capMs: 300_000, resetAfterMs: 30_000, jitter: 0.25 };
/** How often a session on a later route tries the earlier (better) ones. */
export const PREFLIGHT_MS = 2 * 60_000;
export const PROBE_TIMEOUT_MS = 5_000;
/** A cheap read the probe sends over the live session. */
export const PROBE_METHOD = "workspace.list";

export type ProbeTrigger = "foreground" | "online" | "offline" | "retry";

/** The delay before attempt `attempt` (0-based, after that many failures). */
export function backoffDelay(attempt: number, random: number, b: Backoff = BACKOFF): number {
  const raw = Math.min(b.capMs, b.baseMs * 2 ** attempt);
  const jittered = raw * (1 - b.jitter + 2 * b.jitter * random);
  return Math.min(b.capMs, Math.max(0, Math.round(jittered)));
}

export type SupervisorOptions = {
  environment: Environment;
  /**
   * The URL to open for a route, asked again on every attempt: a key route
   * gets a fresh 30 s ticket from the main process. Throws `unauthorized: …`
   * when the credential is refused and `unavailable: …` when the host did
   * not answer; either moves the walk to the next route.
   */
  resolveUrl: (route: Route) => Promise<string>;
  profileFor: (route: Route) => WireProfile;
  transport?: (url: string, profile: WireProfile) => Transport;
  clock?: Clock;
  backoff?: Backoff;
  preflightMs?: number;
  probeTimeoutMs?: number;
  probeMethod?: string;
  onStatus?: (status: EnvironmentStatus) => void;
  /** The live session changed: a replacement transport, or null while none. */
  onSession?: (session: Transport | null) => void;
};

/**
 * One environment's connection owner. It walks the routes best-first, keeps
 * one session, retries involuntary losses on a jittered exponential backoff
 * that resets only after the session stays up, probes the live session on
 * foreground / online / explicit retry and reconnects only when the probe
 * fails, preflights earlier routes while sitting on a later one, and never
 * retries a refused credential or a host that changed identity by itself.
 */
export class Supervisor {
  status: EnvironmentStatus = { ...IDLE_STATUS };
  session: Transport | null = null;
  environment: Environment;
  private readonly clock: Clock;
  private readonly backoff: Backoff;
  private retryTimer: unknown = null;
  private upTimer: unknown = null;
  private preflightTimer: unknown = null;
  private attempting: Promise<void> | null = null;
  private probing: Promise<void> | null = null;
  private everOpened = false;
  private stopped = true;
  private online = true;
  /** The host answered with another environment's id: wait for an explicit retry. */
  private halted = false;
  /** The route the live session was opened over (its URL carries no ticket). */
  private liveRoute: Route | null = null;
  /** Bumps on stop/retry so a walk still in flight drops its result. */
  private generation = 0;

  constructor(private readonly options: SupervisorOptions) {
    this.environment = options.environment;
    this.clock = options.clock ?? realClock;
    this.backoff = options.backoff ?? BACKOFF;
  }

  /** Begin connecting. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.halted = false;
    void this.attempt();
  }

  /** Stop for good (the environment was removed): close the session, retry nothing. */
  stop(): void {
    this.stopped = true;
    this.generation++;
    this.clearRetry();
    this.clearUp();
    this.clearPreflight();
    const session = this.session;
    this.session = null;
    this.liveRoute = null;
    session?.close({ kind: "local", message: "stopped" });
    this.set({ ...IDLE_STATUS, lastHello: this.status.lastHello });
    this.options.onSession?.(null);
  }

  /** The user asked: probe an open session, else try now, out of any state. */
  retry(): void {
    if (this.stopped) return;
    this.halted = false;
    if (this.status.transport === "unauthorized" || this.status.transport === "offline")
      this.status = { ...this.status, attempts: 0 };
    void this.probe("retry");
  }

  /** The OS or browser said the network came or went. */
  setOnline(online: boolean): void {
    this.online = online;
    if (this.stopped) return;
    if (online) void this.probe("online");
    else if (this.session) void this.probe("offline");
    else {
      this.clearRetry();
      this.set({ ...this.status, transport: "offline", nextRetryAt: null });
    }
  }

  /**
   * Check the live session with one cheap request; only a failed probe
   * reconnects, and then at once. With no session, a pending retry fires now.
   */
  probe(trigger: ProbeTrigger): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.status.transport === "unauthorized" && trigger !== "retry") return Promise.resolve();
    if (this.halted && trigger !== "retry") return Promise.resolve();
    if (!this.online && trigger !== "online" && trigger !== "retry") {
      if (this.session) return this.probeSession(this.session, trigger);
      return Promise.resolve();
    }
    if (this.session) return this.probeSession(this.session, trigger);
    this.clearRetry();
    return this.attempt();
  }

  /** The stores finished their re-list on the live session (or lost it). */
  markFresh(fresh: boolean): void {
    if (this.status.fresh === fresh) return;
    this.set({ ...this.status, fresh });
  }

  /** Routes or name changed: keep the session if its route survived. */
  update(environment: Environment): void {
    this.environment = environment;
    const live = this.session;
    if (!live) return;
    const index = environment.routes.findIndex((r) => r.url === this.liveRoute?.url);
    if (index < 0) {
      live.close({ kind: "replaced", message: "route removed" });
      this.lost(live, { kind: "replaced", message: "route removed" });
      void this.attempt();
      return;
    }
    this.set({ ...this.status, route: index });
    this.schedulePreflight(index, 1_000);
  }

  // ── attempts ───────────────────────────────────────────────────────

  private attempt(): Promise<void> {
    if (this.attempting) return this.attempting;
    const generation = ++this.generation;
    this.attempting = this.walk(generation).finally(() => {
      this.attempting = null;
    });
    return this.attempting;
  }

  private async walk(generation: number): Promise<void> {
    this.clearRetry();
    this.set({ ...this.status, transport: this.pendingState(), nextRetryAt: null });
    const routes = this.environment.routes;
    let unauthorized = 0;
    let lastError: string | null = routes.length ? null : "no routes";
    for (let i = 0; i < routes.length; i++) {
      const route = routes[i];
      let url: string;
      try {
        url = await this.options.resolveUrl(route);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isUnauthorizedMessage(message)) unauthorized++;
        lastError = message;
        continue;
      }
      if (generation !== this.generation) return;
      const transport = this.open(url, route);
      try {
        const hello = await transport.open();
        if (generation !== this.generation) {
          transport.close({ kind: "local", message: "superseded" });
          return;
        }
        if (!this.adopt(transport, i, hello)) return;
        return;
      } catch (err) {
        const reason = transport.closeReason;
        if (reason?.kind === "unauthorized") unauthorized++;
        lastError = reason?.message ?? (err instanceof Error ? err.message : String(err));
      }
    }
    if (generation !== this.generation) return;
    if (unauthorized > 0) {
      this.set({ ...this.status, transport: "unauthorized", lastError, nextRetryAt: null });
      return;
    }
    if (!this.online) {
      this.set({ ...this.status, transport: "offline", lastError, nextRetryAt: null });
      return;
    }
    this.scheduleRetry(lastError);
  }

  private open(url: string, route: Route): Transport {
    const profile = this.options.profileFor(route);
    return this.options.transport ? this.options.transport(url, profile) : new Transport(url, profile);
  }

  /** A hello arrived on `transport`: make it the session. False when the host is not who we saved. */
  private adopt(transport: Transport, index: number, hello: Hello): boolean {
    const route = this.environment.routes[index] ?? null;
    const expected = this.environment.credentialRef ? this.environment.id : null;
    if (expected && hello.environmentId !== expected) {
      const message = `host identity changed: expected ${expected}, got ${hello.environmentId}`;
      transport.close({ kind: "protocol", message });
      this.halted = true;
      this.set({ ...this.status, transport: "offline", lastError: message, nextRetryAt: null, lastHello: hello });
      return false;
    }
    const previous = this.session;
    this.session = transport;
    this.liveRoute = route;
    this.everOpened = true;
    this.clearRetry();
    this.clearUp();
    transport.onClose((reason) => this.lost(transport, reason));
    this.upTimer = this.clock.setTimeout(() => {
      this.upTimer = null;
      if (this.session === transport) this.set({ ...this.status, attempts: 0 });
    }, this.backoff.resetAfterMs);
    this.set({
      ...this.status,
      transport: "open",
      fresh: false,
      lastHello: hello,
      lastError: null,
      nextRetryAt: null,
      route: index,
    });
    this.options.onSession?.(transport);
    previous?.close({ kind: "replaced", message: "a better route answered" });
    this.schedulePreflight(index);
    return true;
  }

  /** The session closed under us. Our own closes already moved on. */
  private lost(transport: Transport, reason: CloseReason): void {
    if (this.session !== transport) return;
    this.session = null;
    this.liveRoute = null;
    this.clearUp();
    this.clearPreflight();
    this.status = { ...this.status, fresh: false, route: null };
    this.options.onSession?.(null);
    if (this.stopped || reason.kind === "replaced") {
      this.emit();
      return;
    }
    if (reason.kind === "unauthorized") {
      this.set({ ...this.status, transport: "unauthorized", lastError: reason.message, nextRetryAt: null });
      return;
    }
    if (reason.kind === "local") {
      // A failed probe closes with `local` and reconnects at once.
      this.set({ ...this.status, transport: this.pendingState(), lastError: reason.message, nextRetryAt: null });
      void this.attempt();
      return;
    }
    if (!this.online) {
      this.set({ ...this.status, transport: "offline", lastError: reason.message, nextRetryAt: null });
      return;
    }
    this.scheduleRetry(reason.message);
  }

  private scheduleRetry(lastError: string | null): void {
    const attempts = this.status.attempts + 1;
    const delay = backoffDelay(attempts - 1, this.clock.random(), this.backoff);
    this.clearRetry();
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = null;
      void this.attempt();
    }, delay);
    this.set({
      ...this.status,
      transport: this.pendingState(),
      lastError,
      attempts,
      nextRetryAt: this.clock.now() + delay,
    });
  }

  private pendingState(): TransportState {
    return this.everOpened ? "reconnecting" : "connecting";
  }

  // ── probes ─────────────────────────────────────────────────────────

  private probeSession(session: Transport, trigger: ProbeTrigger): Promise<void> {
    if (this.probing) return this.probing;
    this.probing = (async () => {
      const ok = await this.withTimeout(
        session.request(this.options.probeMethod ?? PROBE_METHOD, undefined),
        this.options.probeTimeoutMs ?? PROBE_TIMEOUT_MS,
      );
      if (this.session !== session || session.state !== "open") return;
      if (ok) {
        this.markFresh(true);
        return;
      }
      session.close({ kind: "local", message: `probe on ${trigger} failed` });
      this.lost(session, { kind: "local", message: `probe on ${trigger} failed` });
    })().finally(() => {
      this.probing = null;
    });
    return this.probing;
  }

  private withTimeout(request: Promise<unknown>, ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = this.clock.setTimeout(() => resolve(false), ms);
      request.then(
        () => {
          this.clock.clearTimeout(timer);
          resolve(true);
        },
        () => {
          this.clock.clearTimeout(timer);
          resolve(false);
        },
      );
    });
  }

  // ── preflight ──────────────────────────────────────────────────────

  private schedulePreflight(index: number, delay = this.options.preflightMs ?? PREFLIGHT_MS): void {
    this.clearPreflight();
    if (index <= 0) return;
    this.preflightTimer = this.clock.setTimeout(() => {
      this.preflightTimer = null;
      void this.preflight();
    }, delay);
  }

  /** Try the routes ahead of the live one; the first that answers takes over. */
  private async preflight(): Promise<void> {
    const live = this.session;
    const liveIndex = this.status.route;
    if (!live || liveIndex === null || liveIndex <= 0 || this.stopped) return;
    const generation = this.generation;
    for (let i = 0; i < liveIndex; i++) {
      if (this.session !== live || generation !== this.generation) return;
      const route = this.environment.routes[i];
      let url: string;
      try {
        url = await this.options.resolveUrl(route);
      } catch {
        continue;
      }
      if (this.session !== live || generation !== this.generation) return;
      const transport = this.open(url, route);
      try {
        const hello = await transport.open();
        if (this.session !== live || generation !== this.generation) {
          transport.close({ kind: "local", message: "superseded" });
          return;
        }
        this.adopt(transport, i, hello);
        return;
      } catch {
        /* this route is still down; try the next */
      }
    }
    if (this.session === live) this.schedulePreflight(liveIndex);
  }

  // ── status ─────────────────────────────────────────────────────────

  private set(status: EnvironmentStatus): void {
    this.status = status;
    this.emit();
  }

  private emit(): void {
    this.options.onStatus?.(this.status);
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) this.clock.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private clearUp(): void {
    if (this.upTimer !== null) this.clock.clearTimeout(this.upTimer);
    this.upTimer = null;
  }

  private clearPreflight(): void {
    if (this.preflightTimer !== null) this.clock.clearTimeout(this.preflightTimer);
    this.preflightTimer = null;
  }
}
