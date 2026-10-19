import { useEffect, useState } from "react";
import { degradedText, registry, useEnvironmentDegraded, useEnvironments, type Degraded } from "../lib/connection";
import { shell } from "../stores/shell";

/**
 * One thin line above a thread's composer while the thread's host is not
 * reachable: what is wrong, the next retry, and the one action that helps.
 * The rows above stay as they were; only sending waits. Nothing shows for
 * a drop that comes back inside the grace period (lib/connection/degraded).
 */

/** The reason a thread cannot take a message right now, or null. */
export function useEnvironmentBlock(environmentId: string): { degraded: Degraded | null; name: string; text: string | null } {
  const degraded = useEnvironmentDegraded(environmentId);
  const name = useEnvironments().find((e) => e.id === environmentId)?.name ?? environmentId;
  const counting = degraded?.kind === "reconnecting" && degraded.status.nextRetryAt !== null;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!counting) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [counting, degraded?.status.nextRetryAt]);
  return { degraded, name, text: degraded ? degradedText(name, degraded, now) : null };
}

export function ConnectionLine({ environmentId }: { environmentId: string }) {
  const { degraded, text } = useEnvironmentBlock(environmentId);
  if (!degraded || !text) return null;
  const unauthorized = degraded.kind === "unauthorized";
  return (
    <div
      role="status"
      data-connection-line={degraded.kind}
      className="mb-1.5 flex h-6 items-center gap-2 px-1 text-[11px] text-content/50"
    >
      <span
        aria-hidden
        className={`size-1.5 shrink-0 rounded-full ${
          unauthorized ? "bg-danger" : degraded.kind === "offline" ? "bg-content/25" : "bg-warning motion-safe:animate-pulse"
        }`}
      />
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {unauthorized ? (
        <button type="button" onClick={() => shell.openSettings("environments")} className="pressable shrink-0 rounded px-1.5 py-0.5 hover:bg-content/10 hover:text-content">
          Pair again
        </button>
      ) : degraded.kind !== "connecting" ? (
        <button type="button" onClick={() => registry.retry(environmentId)} className="pressable shrink-0 rounded px-1.5 py-0.5 hover:bg-content/10 hover:text-content">
          Retry now
        </button>
      ) : null}
    </div>
  );
}
