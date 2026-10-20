import type { WireProfile } from "@server/shared/wire";
import { EnvLink } from "./link";
import { Supervisor, type Clock, type ProbeTrigger } from "./supervisor";
import type { Transport } from "./transport";
import { IDLE_STATUS, type Environment, type EnvironmentStatus, type Route } from "./types";

export const LOCAL_ENVIRONMENT_ID = "local";
export const WEB_ENVIRONMENT_ID = "web";

export type LinkEvent = "added" | "removed";

export type RegistryOptions = {
  /** The wire profile a route's socket opens with. */
  profileFor?: (environment: Environment, route: Route) => WireProfile;
  /** The URL to open for a route; a key route needs a fresh ticket every time. */
  resolveUrl?: (environment: Environment, route: Route) => Promise<string>;
  transport?: (url: string, profile: WireProfile) => Transport;
  clock?: Clock;
};

type Entry = { environment: Environment; supervisor: Supervisor; link: EnvLink };

/**
 * Every environment this window talks to: its supervisor, its link and its
 * status. Adding an environment starts connecting and hands the stores a
 * link through `onLink`; an involuntary disconnect changes nothing here
 * (the registration and every store's data stay, the supervisor retries);
 * only an explicit `remove` stops the supervisor and tells the stores to
 * clear that environment. Statuses are one snapshot map for React.
 */
export class ConnectionRegistry {
  private entries = new Map<string, Entry>();
  private statusSnapshot: ReadonlyMap<string, EnvironmentStatus> = new Map();
  private environmentList: Environment[] = [];
  /** The environment machine-level work defaults to: `local` in the desktop window, `web` at /ui. */
  private primaryId = LOCAL_ENVIRONMENT_ID;
  /** The primary link handed out before its environment was added (boot
   *  asks preload for the port first); `add` adopts it, so listeners that
   *  attached early hear the first open. */
  private pendingPrimary: EnvLink | null = null;
  private statusListeners = new Set<() => void>();
  private linkListeners = new Set<(link: EnvLink, event: LinkEvent) => void>();

  constructor(private readonly options: RegistryOptions = {}) {}

  environments(): Environment[] {
    return [...this.entries.values()].map((e) => e.environment);
  }

  /** The same array until an environment is added, updated or removed. */
  environmentsSnapshot(): Environment[] {
    return this.environmentList;
  }

  environment(id: string): Environment | undefined {
    return this.entries.get(id)?.environment;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  link(id: string): EnvLink | undefined {
    return this.entries.get(id)?.link;
  }

  links(): EnvLink[] {
    return [...this.entries.values()].map((e) => e.link);
  }

  /** The link for `id`, or a thrown error: callers name a known environment.
   *  The primary id always answers, with a link that opens once its
   *  environment is added. */
  linkOf(id: string): EnvLink {
    const link = this.link(id);
    if (link) return link;
    if (id === this.primaryId) return (this.pendingPrimary ??= new EnvLink(id, pageProfile()));
    throw new Error(`unknown environment: ${id}`);
  }

  /** Name the primary environment before it is added (web mode does, at boot). */
  setPrimary(id: string): void {
    if (this.primaryId === id) return;
    this.primaryId = id;
    this.pendingPrimary = null;
  }

  get primaryEnvironmentId(): string {
    return this.primaryId;
  }

  /** This machine's own server in the desktop window, the page's host at /ui. */
  primary(): EnvLink {
    return this.linkOf(this.primaryId);
  }

  supervisor(id: string): Supervisor | undefined {
    return this.entries.get(id)?.supervisor;
  }

  /** Register and start connecting; an existing id takes the new routes and name. */
  add(environment: Environment): EnvLink {
    const existing = this.entries.get(environment.id);
    if (existing) {
      this.update(environment);
      return existing.link;
    }
    const link =
      environment.id === this.primaryId && this.pendingPrimary
        ? this.pendingPrimary
        : new EnvLink(environment.id, this.defaultProfile(environment));
    if (link === this.pendingPrimary) this.pendingPrimary = null;
    const supervisor = this.createSupervisor(environment, link);
    const entry: Entry = { environment, supervisor, link };
    this.entries.set(environment.id, entry);
    this.environmentList = this.environments();
    this.setStatus(environment.id, supervisor.status);
    for (const l of this.linkListeners) l(link, "added");
    supervisor.start();
    return link;
  }

  private createSupervisor(environment: Environment, link: EnvLink): Supervisor {
    return new Supervisor({
      environment,
      resolveUrl: (route) => this.resolveUrl(environment, route),
      profileFor: (route) => this.profileFor(environment, route),
      transport: this.options.transport,
      clock: this.options.clock,
      onStatus: (status) => this.setStatus(environment.id, status),
      onSession: (session) => link.setSession(session),
    });
  }

  update(environment: Environment): void {
    const entry = this.entries.get(environment.id);
    if (!entry) return;
    const keyChanged = entry.environment.keyId !== environment.keyId || entry.environment.credentialRef !== environment.credentialRef;
    entry.environment = environment;
    this.environmentList = this.environments();
    if (keyChanged) {
      // Keep the stores' link and data, but discard the old supervisor's
      // unauthorized state and any ticket request still in flight.
      entry.supervisor.stop();
      entry.supervisor = this.createSupervisor(environment, entry.link);
      entry.supervisor.start();
    } else {
      entry.supervisor.update(environment);
    }
    this.emit();
  }

  /** Forget an environment: its socket closes and the stores drop its data. */
  remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.supervisor.stop();
    this.entries.delete(id);
    this.environmentList = this.environments();
    const next = new Map(this.statusSnapshot);
    next.delete(id);
    this.statusSnapshot = next;
    for (const l of this.linkListeners) l(entry.link, "removed");
    this.emit();
  }

  retry(id: string): void {
    this.entries.get(id)?.supervisor.retry();
  }

  retryAll(): void {
    for (const e of this.entries.values()) e.supervisor.retry();
  }

  /** Foreground, online: every supervisor probes its session. */
  probeAll(trigger: ProbeTrigger): void {
    for (const e of this.entries.values()) void e.supervisor.probe(trigger);
  }

  setOnline(online: boolean): void {
    for (const e of this.entries.values()) e.supervisor.setOnline(online);
  }

  markFresh(id: string, fresh: boolean): void {
    this.entries.get(id)?.supervisor.markFresh(fresh);
  }

  // ── status for React ───────────────────────────────────────────────

  statusOf(id: string): EnvironmentStatus {
    return this.statusSnapshot.get(id) ?? IDLE_STATUS;
  }

  /** One stable map per change, for useSyncExternalStore. */
  statuses(): ReadonlyMap<string, EnvironmentStatus> {
    return this.statusSnapshot;
  }

  subscribe(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /** The stores' hook: a link to attach to, or one to clear out. Fires for
   *  every existing link at once so a late subscriber catches up. */
  onLink(listener: (link: EnvLink, event: LinkEvent) => void): () => void {
    this.linkListeners.add(listener);
    for (const e of this.entries.values()) listener(e.link, "added");
    return () => {
      this.linkListeners.delete(listener);
    };
  }

  /** Window hooks: a window coming forward or the network returning probes
   *  every session; the network leaving pauses retries. */
  installWindowHooks(win: Window = window): () => void {
    const onVisible = (): void => {
      if (win.document.visibilityState === "visible") this.probeAll("foreground");
    };
    const onFocus = (): void => this.probeAll("foreground");
    const onOnline = (): void => this.setOnline(true);
    const onOffline = (): void => this.setOnline(false);
    win.document.addEventListener("visibilitychange", onVisible);
    win.addEventListener("focus", onFocus);
    win.addEventListener("online", onOnline);
    win.addEventListener("offline", onOffline);
    if (win.navigator && win.navigator.onLine === false) this.setOnline(false);
    return () => {
      win.document.removeEventListener("visibilitychange", onVisible);
      win.removeEventListener("focus", onFocus);
      win.removeEventListener("online", onOnline);
      win.removeEventListener("offline", onOffline);
    };
  }

  /** Test seam: stop every supervisor and forget everything. */
  reset(): void {
    for (const id of [...this.entries.keys()]) this.remove(id);
  }

  // ── defaults ───────────────────────────────────────────────────────

  private profileFor(environment: Environment, route: Route): WireProfile {
    if (this.options.profileFor) return this.options.profileFor(environment, route);
    return route.kind === "loopback" && route.credential === "implicit" ? pageProfile() : "remote";
  }

  private defaultProfile(environment: Environment): WireProfile {
    const first = environment.routes[0];
    return first ? this.profileFor(environment, first) : "remote";
  }

  private async resolveUrl(environment: Environment, route: Route): Promise<string> {
    if (this.options.resolveUrl) return this.options.resolveUrl(environment, route);
    if (route.credential === "key") {
      if (!environment.credentialRef) throw new Error(`unauthorized: ${environment.name} has no saved key`);
      const minted = await this.primary().request<{ ticket: string }>("remote.environments.ticket", {
        id: environment.credentialRef,
        url: route.url,
      });
      const url = new URL(route.url);
      url.searchParams.set("ticket", minted.ticket);
      return url.toString();
    }
    if (route.credential === "implicit" && this.profileFor(environment, route) === "remote") {
      const url = new URL(route.url);
      url.searchParams.set("profile", "remote");
      return url.toString();
    }
    return route.url;
  }

  private setStatus(id: string, status: EnvironmentStatus): void {
    const next = new Map(this.statusSnapshot);
    next.set(id, status);
    this.statusSnapshot = next;
    this.emit();
  }

  private emit(): void {
    for (const l of this.statusListeners) l();
  }
}

/** The port this machine's server answers on, read off the local link's live
 *  socket: the LSP and DAP tunnels open their own sockets there. Null while
 *  the local environment is not connected (or this is the /ui page). */
export function localServerPort(): number | null {
  const url = registry.link(LOCAL_ENVIRONMENT_ID)?.transport?.url;
  if (!url) return null;
  try {
    const port = new URL(url).port;
    return port ? Number(port) : null;
  } catch {
    return null;
  }
}

/** `?profile=remote` on the page URL asks the loopback socket for the remote shapes. */
export function pageProfile(): WireProfile {
  if (typeof location === "undefined") return "local";
  return new URLSearchParams(location.search).get("profile") === "remote" ? "remote" : "local";
}

/** Environment zero: this machine's server on its loopback port. */
export function localEnvironment(port: number): Environment {
  return {
    id: LOCAL_ENVIRONMENT_ID,
    name: "This Mac",
    routes: [{ url: `ws://127.0.0.1:${port}`, kind: "loopback", credential: "implicit" }],
    credentialRef: null,
  };
}

/** The page at /ui: exactly one environment, its own origin, the cookie on the upgrade. */
export function webEnvironment(socketUrl: string, name = "This host"): Environment {
  return {
    id: WEB_ENVIRONMENT_ID,
    name,
    routes: [{ url: socketUrl, kind: "tunnel", credential: "cookie" }],
    credentialRef: null,
  };
}

/** A saved remote host as the main process lists it. */
export function savedEnvironment(saved: {
  keyId?: string;
  id: string;
  name: string;
  routes: { url: string; kind: Route["kind"] }[];
}): Environment {
  return {
    id: saved.id,
    name: saved.name,
    routes: saved.routes.map((r) => ({ url: r.url, kind: r.kind, credential: "key" })),
    credentialRef: saved.id,
    ...(saved.keyId !== undefined ? { keyId: saved.keyId } : {}),
  };
}

/** The one registry of the window. */
export const registry = new ConnectionRegistry();
