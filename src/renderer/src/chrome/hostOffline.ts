import { useSyncExternalStore } from "react";
import { registry } from "../lib/connection/registry";

/**
 * The offline tint's rule: with two or more hosts registered, a row whose
 * every host's link is not open is dimmed (`opacity-50`,
 * `data-host-offline`), as the master board's rows are. One host never
 * tints: its rows are all there is. Reads a boolean, so a status change
 * re-renders only the rows it flips.
 */
export function hostsOffline(hosts: readonly (string | undefined)[]): boolean {
  const known = hosts.filter((id): id is string => !!id);
  if (known.length === 0 || registry.environmentsSnapshot().length < 2) return false;
  return known.every((id) => registry.statusOf(id).transport !== "open");
}

export function useHostsOffline(hosts: readonly (string | undefined)[]): boolean {
  const key = hosts.join("\n");
  return useSyncExternalStore(registry.subscribe.bind(registry), () => hostsOffline(key.split("\n")));
}
