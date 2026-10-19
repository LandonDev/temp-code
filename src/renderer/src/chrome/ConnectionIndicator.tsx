import { registry, useEnvironmentStatuses, useEnvironments, type EnvironmentStatus } from "../lib/connection";

/**
 * One dot per environment in the sidebar header: the transport state at a
 * glance, the details in the title, a click retries. Thread K2 builds the
 * real environment UI; this only makes the connection runtime visible.
 */

function tone(status: EnvironmentStatus): string {
  switch (status.transport) {
    case "open":
      return status.fresh ? "bg-success" : "bg-success/50";
    case "connecting":
    case "reconnecting":
      return "bg-warning motion-safe:animate-pulse";
    case "unauthorized":
      return "bg-destructive";
    default:
      return "bg-content/25";
  }
}

function describe(name: string, status: EnvironmentStatus, now: number): string {
  const wait = status.nextRetryAt ? Math.max(0, Math.round((status.nextRetryAt - now) / 1000)) : null;
  const state =
    status.transport === "open"
      ? status.fresh
        ? "connected"
        : "connected, catching up"
      : status.transport === "reconnecting" || status.transport === "connecting"
        ? wait !== null
          ? `${status.transport}, next try in ${wait} s`
          : status.transport
        : status.transport;
  return `${name}: ${state}${status.lastError ? ` (${status.lastError})` : ""}. Click to retry.`;
}

export function ConnectionIndicator() {
  const environments = useEnvironments();
  const statuses = useEnvironmentStatuses();
  if (environments.length === 0) return null;
  const now = Date.now();
  return (
    <div className="flex items-center gap-1 px-1" aria-label="Connections">
      {environments.map((env) => {
        const status = statuses.get(env.id);
        if (!status) return null;
        return (
          <button
            key={env.id}
            type="button"
            title={describe(env.name, status, now)}
            aria-label={describe(env.name, status, now)}
            onClick={() => registry.retry(env.id)}
            className="grid size-4 place-items-center rounded-sm hover:bg-content/5"
          >
            <span className={`size-1.5 rounded-full ${tone(status)}`} />
          </button>
        );
      })}
    </div>
  );
}
