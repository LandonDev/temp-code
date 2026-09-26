import type { ProfileView } from "aliax-core/shared/types";
import {
  isRoutedProvider,
  type ProviderAccounts,
  type RoutedProvider,
} from "@server/shared/accounts";
import type { ProjectMeta, WorkspaceMeta } from "@server/shared/domain";

/** The fields of a thread (or a thread about to be created) that decide its account. */
export interface ScopeMeta {
  provider: string;
  accountPin?: string | null;
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
  /** The explicit thread pin. */
  pin: string | null;
  /** The project's or workspace's pin that applies when the thread has none. */
  inherited: InheritedPin | null;
  /** The account the thread spends from now (null before its first spawn). */
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
  const pin = meta.accountPin ?? null;
  const current = meta.account ?? null;
  return { provider, pin, inherited, current, shown: current ?? pin ?? inherited?.name ?? null };
}

/** One line on where the thread's account comes from. */
export function sourceLine(scope: AccountScope): string {
  if (scope.pin) return "Pinned to this thread";
  if (scope.inherited) return `From ${scope.inherited.level} ${scope.inherited.from}`;
  return "Auto · picked by model";
}

/** What clearing the thread pin falls back to. */
export function autoLine(scope: AccountScope, profiles: readonly ProfileView[]): string {
  if (!scope.inherited) return "Picked by model, moved when it runs out";
  const profile = profiles.find((p) => p.name === scope.inherited?.name);
  return `${scope.inherited.level === "project" ? "Project" : "Workspace"} ${scope.inherited.from} · ${profile ? shortName(profile) : scope.inherited.name}`;
}

/** The nickname, else the email's local part, else the profile name. */
export function shortName(p: ProfileView): string {
  if (p.nickname) return p.nickname;
  const source = p.email ?? p.name;
  const at = source.indexOf("@");
  return at > 0 ? source.slice(0, at) : source;
}

/** The label the composer control shows for a thread. */
export function controlLabel(scope: AccountScope, accounts: ProviderAccounts): string {
  const name = scope.shown;
  if (!name) return "Auto";
  const profile = accounts.profiles.find((p) => p.name === name);
  return profile ? shortName(profile) : name;
}
