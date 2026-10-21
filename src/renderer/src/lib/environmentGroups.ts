import type { Environment } from "./connection/types";
import type { RecentProject } from "./recents";

export type EnvironmentGroup = {
  environment: Environment;
  items: RecentProject[];
};

/**
 * The rail's workspace rows split by the machine they live on, in the
 * registry's order (this machine first); a folder no host claims is this
 * machine's. Every environment gets a group, even an empty one, so the
 * user can add a workspace there.
 */
export function groupByEnvironment(
  items: readonly RecentProject[],
  environments: readonly Environment[],
  environmentOf: (path: string) => string | undefined,
): EnvironmentGroup[] {
  const groups = environments.map((environment) => ({ environment, items: [] as RecentProject[] }));
  const byId = new Map(groups.map((g) => [g.environment.id, g] as const));
  const fallback = groups[0];
  for (const item of items) {
    const id = environmentOf(item.path);
    ((id !== undefined ? byId.get(id) : undefined) ?? fallback)?.items.push(item);
  }
  return groups;
}
