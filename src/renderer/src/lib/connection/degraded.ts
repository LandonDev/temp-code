import { useEffect, useState } from "react";
import { useEnvironmentStatus } from "./status";
import type { EnvironmentStatus, TransportState } from "./types";

/**
 * What the chrome says about an environment that is not open. A socket
 * that drops and returns inside the backoff must not flicker the thread
 * read-only, so connecting and reconnecting count only after a grace
 * period; a refused credential or a stopped environment shows at once.
 */

export const DEGRADED_GRACE_MS = 1500;

export type Degraded = {
  kind: Exclude<TransportState, "open">;
  status: EnvironmentStatus;
};

export function degradedFor(status: EnvironmentStatus, sinceMs: number): Degraded | null {
  if (status.transport === "open") return null;
  if (status.transport === "unauthorized" || status.transport === "offline") return { kind: status.transport, status };
  return sinceMs >= DEGRADED_GRACE_MS ? { kind: status.transport, status } : null;
}

/** One line for a status line or a tooltip; `now` keeps the countdown honest. */
export function degradedText(name: string, degraded: Degraded, now: number): string {
  const { status } = degraded;
  switch (degraded.kind) {
    case "unauthorized":
      return `${name} no longer accepts this key`;
    case "offline":
      return status.lastError ? `${name} is offline: ${status.lastError}` : `${name} is offline`;
    case "connecting":
      return `Connecting to ${name}…`;
    case "reconnecting": {
      const wait = status.nextRetryAt ? Math.max(0, Math.ceil((status.nextRetryAt - now) / 1000)) : null;
      return wait === null || wait === 0 ? `Reconnecting to ${name}…` : `${name} dropped; retrying in ${wait} s`;
    }
  }
}

export function useEnvironmentDegraded(id: string): Degraded | null {
  const status = useEnvironmentStatus(id);
  const open = status.transport === "open";
  const [since, setSince] = useState<number | null>(open ? null : Date.now());
  const [, tick] = useState(0);
  useEffect(() => {
    if (open) {
      setSince(null);
      return;
    }
    const start = Date.now();
    setSince((s) => s ?? start);
    const left = DEGRADED_GRACE_MS - (Date.now() - start);
    const t = window.setTimeout(() => tick((n) => n + 1), Math.max(0, left) + 1);
    return () => window.clearTimeout(t);
  }, [open]);
  return degradedFor(status, since === null ? 0 : Date.now() - since);
}
