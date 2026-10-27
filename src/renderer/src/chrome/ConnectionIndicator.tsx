import { registry, useEnvironmentDegraded, useEnvironmentStatus, useEnvironments, useSlowEnvironments, type Environment } from "../lib/connection";
import { EnvironmentSwitcher, toneOf } from "./EnvironmentSwitcher";
import { statusText } from "../lib/hostConnection";

/**
 * The sidebar header's connection state. One environment: a dot for this
 * machine's socket (the details in the title, a click retries). Several:
 * the environment switcher, which names the machine on screen and lists
 * the others. A drop that comes back inside the backoff never changes the
 * dot: the degraded state waits out a grace period first.
 */
export function ConnectionIndicator() {
  const environments = useEnvironments();
  if (environments.length === 0) return null;
  if (environments.length > 1) return <EnvironmentSwitcher />;
  return (
    <div className="flex items-center gap-1 px-1" aria-label="Connections">
      <Dot environment={environments[0]} />
    </div>
  );
}

function Dot({ environment }: { environment: Environment }) {
  const status = useEnvironmentStatus(environment.id);
  const degraded = useEnvironmentDegraded(environment.id);
  const slow = useSlowEnvironments().has(environment.id);
  const text = `${environment.name}: ${statusText(status, Date.now(), slow)}${status.lastError ? ` (${status.lastError})` : ""}. Click to retry.`;
  return (
    <button
      type="button"
      title={text}
      aria-label={text}
      onClick={() => registry.retry(environment.id)}
      className="grid size-4 place-items-center rounded-sm hover:bg-content/5"
    >
      <span className={`size-1.5 rounded-full ${toneOf(status, degraded !== null, slow)}`} />
    </button>
  );
}
