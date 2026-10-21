import { useEffect, useSyncExternalStore } from "react";
import { DEFAULT_MAX_RUNNING, MAX_RUNNING_LIMIT } from "@server/shared/threadCap";
import { registry } from "../connection";

/**
 * The host's running cap (threadCap.ts on the server, `threads.maxRunning`):
 * how many root threads may be in a turn at once; a thread that opted into
 * the queue waits past it. One number per host, loaded the first time
 * Settings asks for it.
 */

const caps = new Map<string, number>();
const listeners = new Set<() => void>();
const loading = new Set<string>();
let version = 0;

function emit(): void {
  version += 1;
  for (const l of listeners) l();
}

export async function loadThreadCap(environmentId: string): Promise<number> {
  if (loading.has(environmentId)) return caps.get(environmentId) ?? DEFAULT_MAX_RUNNING;
  loading.add(environmentId);
  try {
    const raw = await registry.linkOf(environmentId).request<{ maxRunning?: unknown }>("threads.get");
    const n = Number(raw?.maxRunning);
    const cap = Number.isInteger(n) && n >= 0 && n <= MAX_RUNNING_LIMIT ? n : DEFAULT_MAX_RUNNING;
    caps.set(environmentId, cap);
    emit();
    return cap;
  } finally {
    loading.delete(environmentId);
  }
}

export async function saveThreadCap(environmentId: string, maxRunning: number): Promise<void> {
  await registry.linkOf(environmentId).request("threads.set", { maxRunning });
  caps.set(environmentId, maxRunning);
  emit();
}

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

/** A host's cap, undefined until it has answered. */
export function useThreadCap(environmentId: string | undefined): number | undefined {
  useSyncExternalStore(subscribe, () => version);
  const cap = environmentId ? caps.get(environmentId) : undefined;
  useEffect(() => {
    if (environmentId && cap === undefined) void loadThreadCap(environmentId).catch(() => {});
  }, [cap, environmentId]);
  return cap;
}

/** Test seam. */
export function resetThreadCapForTests(): void {
  caps.clear();
  loading.clear();
}
