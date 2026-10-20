import type { Capability } from "@server/shared/capabilities";

/**
 * The connection runtime's vocabulary (thread K1). An environment is one
 * temp-code host; this machine's own server is the environment `local`,
 * the page served at `/ui` sees exactly one environment, `web`, and a saved
 * remote host keeps the id its `hello` reports across restarts and endpoint
 * changes. The iOS socket actor mirrors these shapes.
 */

export type RouteKind = "loopback" | "lan" | "tunnel";

/** How a route proves who we are: nothing on loopback, the page's cookie at
 *  `/ui`, or a 30 s ticket the main process mints from a saved key. */
export type RouteCredential = "implicit" | "cookie" | "key";

export type Route = {
  /** The WebSocket URL: `ws://127.0.0.1:1234` or `wss://host/ws`. */
  url: string;
  kind: RouteKind;
  credential: RouteCredential;
};

export type Environment = {
  /** `local`, `web`, or the host's own environment id. */
  id: string;
  name: string;
  /** Best first: the supervisor connects over the first route that works
   *  and keeps trying the earlier ones while it sits on a later one. */
  routes: Route[];
  /** The saved-environment id the main process holds the key under; null
   *  for implicit and cookie credentials. */
  credentialRef: string | null;
  /** Public id of the saved key; no bearer material crosses here. */
  keyId?: string;
};

/** The first frame on every socket. */
export type Hello = {
  environmentId: string;
  contract: number;
  caps: Capability[];
  key?: { id: string; name: string };
};

/**
 * Transport health, separate from data freshness:
 * - connecting: no session yet since the environment was added or retried
 * - open: a session is up
 * - reconnecting: a session was lost; the next attempt is at nextRetryAt
 * - offline: nothing is tried until online or an explicit retry (the OS
 *   reports no network, the environment is stopped, or its host changed id)
 * - unauthorized: the credential was refused; only an explicit retry tries again
 */
export type TransportState = "connecting" | "open" | "reconnecting" | "offline" | "unauthorized";

export type EnvironmentStatus = {
  transport: TransportState;
  /** The stores have re-listed on the live session and nothing has failed since. */
  fresh: boolean;
  lastHello: Hello | null;
  lastError: string | null;
  nextRetryAt: number | null;
  /** Index into the environment's routes of the live session; null when none. */
  route: number | null;
  /** Failed attempts since the last connection that stayed up 30 s. */
  attempts: number;
};

export type CloseReason = {
  kind: "unauthorized" | "network" | "server" | "protocol" | "local" | "replaced";
  code?: number;
  message: string;
};

export const IDLE_STATUS: EnvironmentStatus = {
  transport: "offline",
  fresh: false,
  lastHello: null,
  lastError: null,
  nextRetryAt: null,
  route: null,
  attempts: 0,
};

/** Errors from the main process's ticket mint carry `<reason>: <detail>`. */
export function isUnauthorizedMessage(message: string): boolean {
  return /^unauthorized\b/.test(message);
}
