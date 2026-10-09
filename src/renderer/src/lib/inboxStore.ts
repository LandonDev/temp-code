import { useSyncExternalStore } from "react";
import type {
  GithubInboxItem,
  GithubInboxRefreshReason,
  GithubInboxSnapshot,
} from "@server/shared/contract-github";
import { sortInboxItems, type InboxItem } from "./githubTasks";
import {
  linearConnected,
  linearTeamIdsForFetch,
  listLinearIssues,
  listLinearTeams,
  loadHiddenLinearTeamIds,
  type LinearIssue,
} from "./linear";
import { contextForCwd, type Catalog } from "./projectContext";
import { client } from "./tcserver/client";
import type { Link } from "./tcserver/store";
import type { ProjectMeta, WorkspaceMeta } from "./tcserver/types";

/**
 * The inbox's data, beside `workspaceStore`. The GitHub snapshot is what
 * the server keeps in SQLite: one `github.inbox` read when the socket
 * opens (never the network), and `refreshGithub` is the only path that
 * asks the server to fetch, called from the open inbox view alone. The
 * rail dot reads this store, so a closed inbox costs nothing and the dot
 * is right at launch. Linear keeps its renderer fetch, run only while the
 * Linear tab is open.
 */

export type InboxScope = "current" | "all";

export type LinearInboxQuery = {
  assignedToMe: boolean;
  state: "open" | "all";
  hiddenTeamIds?: string[];
};

export type InboxState = {
  github: GithubInboxSnapshot | null;
  githubLoaded: boolean;
  refreshing: boolean;
  linear: {
    items: InboxItem[];
    fetchedAt: number | null;
    error: string | null;
    loading: boolean;
  };
};

const EMPTY: InboxState = {
  github: null,
  githubLoaded: false,
  refreshing: false,
  linear: { items: [], fetchedAt: null, error: null, loading: false },
};

const LINEAR_FRESH_MS = 60_000;

// ── pure helpers ──

/** The workspace a folder belongs to: its project's workspace, else the workspace at that path. */
export function workspaceIdForCwd(catalog: Catalog, cwd: string): string | null {
  if (!cwd) return null;
  return contextForCwd({ ...catalog, cwd }).workspaceId;
}

/** GitHub workspaces, each repo claimed by its oldest workspace. */
export function githubWorkspaces(workspaces: readonly WorkspaceMeta[]): WorkspaceMeta[] {
  return workspaces.filter((w) => w.git && !!w.githubRepo);
}

function claimRepos(workspaces: readonly WorkspaceMeta[]): Map<string, WorkspaceMeta> {
  const byRepo = new Map<string, WorkspaceMeta>();
  for (const w of [...githubWorkspaces(workspaces)].sort((a, b) => a.createdAt - b.createdAt)) {
    const repo = w.githubRepo as string;
    if (!byRepo.has(repo)) byRepo.set(repo, w);
  }
  return byRepo;
}

function sameLogin(a: string | undefined | null, b: string | undefined | null): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

function toInboxItem(
  item: GithubInboxItem,
  workspace: WorkspaceMeta,
  projectPath: string,
  viewer: string | null,
): InboxItem {
  return {
    provider: "github",
    kind: item.kind,
    number: item.number,
    title: item.title,
    url: item.url,
    state: item.state,
    updatedAt: item.updatedAt,
    labels: item.labels,
    assignees: item.assignees,
    draft: item.draft,
    repo: item.repo,
    projectPath,
    workspaceId: workspace.id,
    author: item.author,
    reviewDecision: item.reviewDecision,
    headRefName: item.headRefName,
    baseRefName: item.baseRefName,
    checks: item.checks,
    reviewRequested: item.reviewRequested,
    mine: {
      authored: sameLogin(item.author?.login, viewer),
      assigned: item.assignees.some((p) => sameLogin(p.login, viewer)),
      reviewRequested: item.reviewRequested.some((login) => sameLogin(login, viewer)),
    },
  };
}

/**
 * The snapshot joined with the workspace catalog: one row per item of every
 * repo some workspace names. A repo shared by two workspaces belongs to the
 * older one, so nothing lists twice. `projectPath` is the active project's
 * folder when it lives in the item's workspace, else the workspace folder,
 * so gh detail calls and "Send to agent" run in the right checkout.
 */
export function inboxItemsFromSnapshot(
  snapshot: GithubInboxSnapshot | null,
  workspaces: readonly WorkspaceMeta[],
  projects: readonly ProjectMeta[],
  activeCwd: string,
): InboxItem[] {
  if (!snapshot) return [];
  const byRepo = claimRepos(workspaces);
  const activeWorkspace = workspaceIdForCwd({ workspaces, projects }, activeCwd);
  const items: InboxItem[] = [];
  for (const repo of snapshot.repos) {
    const workspace = byRepo.get(repo.repo);
    if (!workspace) continue;
    const projectPath = activeWorkspace === workspace.id ? activeCwd : workspace.path;
    for (const item of repo.items) {
      items.push(toInboxItem(item, workspace, projectPath, snapshot.viewer));
    }
  }
  return sortInboxItems(items);
}

function linearIssueToInboxItem(issue: LinearIssue): InboxItem {
  return {
    provider: "linear",
    kind: "linear",
    id: issue.id,
    identifier: issue.identifier,
    number: issue.number,
    title: issue.title,
    url: issue.url,
    state: issue.state,
    stateType: issue.stateType,
    updatedAt: issue.updatedAt,
    labels: issue.labels,
    assignees: issue.assignees,
    draft: false,
    repo: issue.repo,
    teamId: issue.teamId,
    teamName: issue.teamName,
    projectPath: issue.projectPath || "",
  };
}

function linearQueryKey(query: LinearInboxQuery): string {
  return `${query.assignedToMe ? 1 : 0}:${query.state}:${[...(query.hiddenTeamIds ?? [])].sort().join(",")}`;
}

// ── store ──

class InboxStore {
  private state: InboxState = EMPTY;
  private listeners = new Set<() => void>();
  private link: Link | null = null;
  private detach: (() => void)[] = [];
  private githubInflight: Promise<GithubInboxSnapshot | null> | null = null;
  private linearInflight: Promise<InboxItem[]> | null = null;
  private linearKey: string | null = null;

  connect(link: Link = client): void {
    if (this.link === link) return;
    for (const off of this.detach) off();
    this.link = link;
    this.detach = [link.onOpen(() => void this.load())];
    if (link.connected) void this.load();
  }

  /** Test seam. */
  reset(): void {
    for (const off of this.detach) off();
    this.detach = [];
    this.link = null;
    this.githubInflight = null;
    this.linearInflight = null;
    this.linearKey = null;
    this.set(EMPTY);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): InboxState => this.state;

  /** The stored snapshot: SQLite on the server, never GitHub. */
  private async load(): Promise<void> {
    if (!this.link) return;
    try {
      const github = await this.link.request<GithubInboxSnapshot>("github.inbox");
      this.set({ ...this.state, github, githubLoaded: true, refreshing: github.refreshing });
    } catch {
      this.set({ ...this.state, githubLoaded: true });
    }
  }

  /** Asks the server to fetch GitHub. The only network path for the inbox;
   *  only the open inbox view calls it. Concurrent calls share one request. */
  refreshGithub(reason: GithubInboxRefreshReason): Promise<GithubInboxSnapshot | null> {
    if (this.githubInflight) return this.githubInflight;
    if (!this.link) return Promise.resolve(this.state.github);
    this.set({ ...this.state, refreshing: true });
    this.githubInflight = this.link
      .request<GithubInboxSnapshot>("github.inboxRefresh", { reason })
      .then((github) => {
        this.set({ ...this.state, github, githubLoaded: true, refreshing: false });
        return github;
      })
      .catch(() => {
        this.set({ ...this.state, refreshing: false });
        return this.state.github;
      })
      .finally(() => {
        this.githubInflight = null;
      });
    return this.githubInflight;
  }

  /** The Linear list for a query, fresh for a minute unless forced. */
  refreshLinear(query: LinearInboxQuery, options: { force?: boolean } = {}): Promise<InboxItem[]> {
    const key = linearQueryKey(query);
    const { linear } = this.state;
    if (
      !options.force &&
      key === this.linearKey &&
      linear.fetchedAt !== null &&
      Date.now() - linear.fetchedAt < LINEAR_FRESH_MS
    ) {
      return Promise.resolve(linear.items);
    }
    if (this.linearInflight && key === this.linearKey) return this.linearInflight;
    this.linearKey = key;
    this.set({ ...this.state, linear: { ...linear, loading: true } });
    const run = fetchLinearItems(query)
      .then((items) => {
        if (this.linearKey !== key) return items;
        this.set({ ...this.state, linear: { items, fetchedAt: Date.now(), error: null, loading: false } });
        return items;
      })
      .catch((err: unknown) => {
        if (this.linearKey !== key) return [];
        const message = err instanceof Error ? err.message : String(err);
        this.set({ ...this.state, linear: { ...this.state.linear, error: message, loading: false } });
        return this.state.linear.items;
      })
      .finally(() => {
        if (this.linearInflight === run) this.linearInflight = null;
      });
    this.linearInflight = run;
    return run;
  }

  private set(next: InboxState): void {
    this.state = next;
    for (const l of this.listeners) l();
  }
}

async function fetchLinearItems(query: LinearInboxQuery): Promise<InboxItem[]> {
  if (!(await linearConnected()).connected) return [];
  const hiddenIds = query.hiddenTeamIds ?? loadHiddenLinearTeamIds();
  let teamIds: string[] | null = null;
  if (hiddenIds.length > 0) {
    teamIds = linearTeamIdsForFetch(await listLinearTeams(), hiddenIds);
    if (teamIds?.length === 0) return [];
  }
  const issues = await listLinearIssues({
    assignedToMe: query.assignedToMe,
    state: query.state,
    teamIds: teamIds ?? [],
  });
  const hidden = new Set(hiddenIds);
  return sortInboxItems(
    issues
      .filter((issue) => hidden.size === 0 || !hidden.has(issue.teamId))
      .map(linearIssueToInboxItem),
  );
}

export const inboxStore = new InboxStore();

export function useInbox(): InboxState {
  return useSyncExternalStore(inboxStore.subscribe, inboxStore.getSnapshot, inboxStore.getSnapshot);
}
