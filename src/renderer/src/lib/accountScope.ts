import type { ProfileView } from "aliax-core/shared/types";
import {
  isRoutedProvider,
  type ProviderAccounts,
  type RoutedProvider,
} from "@server/shared/accounts";
import type { ProjectMeta, WorkspaceMeta } from "@server/shared/domain";

/** The fields of a thread that decide its account. */
export interface ScopeMeta {
  provider: string;
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
  provider: RoutedProvider;
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
  if (!meta || !isRoutedProvider(meta.provider)) return null;
  const provider = meta.provider;
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

/** One line on where the thread's account comes from. */
export function sourceLine(scope: AccountScope): string {
  if (scope.inherited) return `From ${scope.inherited.level} ${scope.inherited.from}`;
  return "Auto · picked by model";
}

/** The nickname, else the email's local part, else the profile name. */
export function shortName(p: ProfileView): string {
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
