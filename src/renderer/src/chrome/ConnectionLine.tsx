import { useEffect, useState } from "react";
import { degradedText, registry, useEnvironmentDegraded, useEnvironments, type Degraded } from "../lib/connection";
import { Spinner } from "../components/ui/spinner";
import { Button } from "../components/ui/button";
import { shell } from "../stores/shell";
import { settingsChunk } from "../surfaces/chunks";

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

/** The line's one action: a ghost button in the line's own 11px muted type. */
const ACTION = "h-5 px-1.5 text-[11px] font-normal text-muted-foreground hover:text-foreground";

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
      {unauthorized || degraded.kind === "offline" ? (
        <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${unauthorized ? "bg-danger" : "bg-content/25"}`} />
      ) : (
        <Spinner aria-hidden className="size-3 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {unauthorized ? (
        <Button variant="ghost" size="xs" {...settingsChunk.intent} onClick={() => shell.openSettings("remote")} className={ACTION}>
          Pair again
        </Button>
      ) : degraded.kind !== "connecting" ? (
        <Button variant="ghost" size="xs" onClick={() => registry.retry(environmentId)} className={ACTION}>
          Retry now
        </Button>
      ) : null}
    </div>
  );
}
