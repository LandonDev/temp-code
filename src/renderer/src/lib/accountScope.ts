import type { ProfileView } from "aliax-core/shared/types";
import {
  pickedProviderOf,
  type PickedProvider,
  type RoutedProvider,
  type ProviderAccounts,
} from "@server/shared/accounts";
import type { ProjectMeta, WorkspaceMeta } from "@server/shared/domain";

/** The fields of a thread that decide its account. */
export interface ScopeMeta {
  provider: string;
  /** A Meta row under either harness spends Meta keys, not the harness's accounts. */
  model?: string | null;
  account?: string | null;
  projectId?: string | null;
  workspaceId?: string | null;
}

export interface InheritedPin {
  name: string;
  level: "project" | "workspace";
  /** The project's or workspace's name. */
  from: string;
}

/** Where a thread's account comes from, as the popover and footer describe it. */
export interface AccountScope {
  provider: PickedProvider;
  /** The project's or workspace's pin that applies to the thread. */
  inherited: InheritedPin | null;
  /** The account the thread spends from (the expected pick until the gateway routes it; null while unknown). */
  current: string | null;
  /** The account to show: the current one, else the pin that will apply. */
  shown: string | null;
}

export function scopeOf(
  meta: ScopeMeta | null | undefined,
  projects: readonly ProjectMeta[],
  workspaces: readonly WorkspaceMeta[],
): AccountScope | null {
  const provider = meta ? pickedProviderOf(meta.provider, meta.model) : null;
  if (!meta || !provider) return null;
  const project = meta.projectId ? projects.find((p) => p.id === meta.projectId) : undefined;
  const workspaceId = project?.workspaceId ?? meta.workspaceId;
  const workspace = workspaceId ? workspaces.find((w) => w.id === workspaceId) : undefined;
  let inherited: InheritedPin | null = null;
  const fromProject = project?.accountPins?.[provider];
  const fromWorkspace = workspace?.accountPins?.[provider];
  if (project && fromProject) inherited = { name: fromProject, level: "project", from: project.name };
  else if (workspace && fromWorkspace) inherited = { name: fromWorkspace, level: "workspace", from: workspace.name };
  const current = meta.account ?? null;
  return { provider, inherited, current, shown: current ?? inherited?.name ?? null };
}

/**
 * Whether a pin row is drawn for a provider: always for the harnesses, and
 * for Meta once the host holds a key or the scope already pins one. A host
 * with no Meta key has nothing to choose, so it is not offered.
 */
export function pinRowShown(provider: RoutedProvider, profiles: readonly unknown[], current: string): boolean {
  return provider !== "meta" || profiles.length > 0 || current !== "";
}

/** One line on where the thread's account comes from. */
export function sourceLine(scope: AccountScope): string {
  const source = scope.inherited ? `From ${scope.inherited.level} ${scope.inherited.from}` : "Auto, picked by model";
  // A Muse thread's host reads its account when it starts: a pick lands at the next start, never mid-turn.
  return scope.provider === "muse" ? `${source}; applies at the next start` : source;
}

/** The nickname, else the email's local part, else the profile name; a key is its name. */
export function shortName(p: ProfileView): string {
  if (p.kind === "key") return p.name;
  if (p.nickname) return p.nickname;
  const source = p.email ?? p.name;
  const at = source.indexOf("@");
  return at > 0 ? source.slice(0, at) : source;
}

/** The label the composer control shows for a thread; null while no account is known. */
export function controlLabel(scope: AccountScope, accounts: ProviderAccounts): string | null {
  const name = scope.shown;
  if (!name) return null;
  const profile = accounts.profiles.find((p) => p.name === name);
  return profile ? shortName(profile) : name;
}
