import { useSyncExternalStore } from "react";
import { registry } from "./registry";
import type { Environment, EnvironmentStatus } from "./types";

/** Every environment's status, one map per change. For K2's environment UI. */
export function useEnvironmentStatuses(): ReadonlyMap<string, EnvironmentStatus> {
  return useSyncExternalStore(registry.subscribe.bind(registry), () => registry.statuses());
}

export function useEnvironmentStatus(id: string): EnvironmentStatus {
  return useSyncExternalStore(registry.subscribe.bind(registry), () => registry.statusOf(id));
}

/** The environments in registration order; changes when one is added or removed. */
export function useEnvironments(): Environment[] {
  return useSyncExternalStore(registry.subscribe.bind(registry), () => registry.environmentsSnapshot());
}

/** The environments whose host is slow to answer (lib/connection/link.ts health). */
export function useSlowEnvironments(): ReadonlySet<string> {
  return useSyncExternalStore(registry.subscribe.bind(registry), () => registry.slowEnvironments());
}
