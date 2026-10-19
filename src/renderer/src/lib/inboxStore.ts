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
import type { Link } from "./connection";
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
    /** Whether the stored list was fetched as "assigned to me". */
    assignedToMe: boolean;
  };
};

const EMPTY: InboxState = {
  github: null,
  githubLoaded: false,
  refreshing: false,
  linear: { items: [], fetchedAt: null, error: null, loading: false, assignedToMe: false },
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

/**
 * Whether the GitHub list is still a guess: the stored snapshot came back
 * but no fetch has ever landed for the repos in view, and one is pending
 * (the open view has not asked yet) or in flight. A fetched snapshot, even
 * an empty one, is a list; a failed login is a message, not a wait.
 */
export function githubInboxLoading(
  state: Pick<InboxState, "github" | "githubLoaded" | "refreshing">,
  repos: readonly string[],
  refreshPending: boolean,
): boolean {
  if (!state.githubLoaded) return true;
  if (!state.refreshing && !refreshPending) return false;
  const snapshot = state.github;
  if (!snapshot) return true;
  if (snapshot.auth.state !== "ok") return false;
  if (snapshot.fetchedAt === null) return true;
  const fetched = new Set(snapshot.repos.map((repo) => repo.repo));
  return repos.some((repo) => !fetched.has(repo));
}

const LINEAR_DONE = new Set(["completed", "canceled", "cancelled"]);

/**
 * Whether an item waits on the viewer: it is open and their review is
 * asked, or it is assigned to them, or it is their own pull request that
 * came back (changes requested), is ready to merge (approved), or has
 * failing checks. Their own drafts never count. Mentions are not in the
 * snapshot, so a bare @-mention does not count either. Linear items count
 * when the stored list was fetched as "assigned to me".
 */
export function inboxNeedsAttention(
  item: InboxItem,
  options: { linearAssignedToMe?: boolean } = {},
): boolean {
  if (item.provider === "linear") {
    return !!options.linearAssignedToMe && !LINEAR_DONE.has(item.stateType ?? "");
  }
  if (item.state !== "open" || !item.mine) return false;
  const { mine } = item;
  if (mine.authored && item.draft) return false;
  if (mine.reviewRequested || mine.assigned) return true;
  if (item.kind !== "pr" || !mine.authored) return false;
  return (
    item.reviewDecision === "CHANGES_REQUESTED" ||
    item.reviewDecision === "APPROVED" ||
    item.checks === "FAILURE" ||
    item.checks === "ERROR"
  );
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

/** Per environment: the host's GitHub inbox snapshot and its Linear list. */
type Slot = {
  link: Link;
  detach: (() => void)[];
  githubInflight: Promise<GithubInboxSnapshot | null> | null;
  linearInflight: Promise<InboxItem[]> | null;
  linearKey: string | null;
};

class InboxStore {
  private states: ReadonlyMap<string, InboxState> = new Map();
  private listeners = new Set<() => void>();
  private slots = new Map<string, Slot>();
  private offRegistry: (() => void) | null = null;

  connect(registry: { onLink(listener: (link: Link, event: "added" | "removed") => void): () => void }): void {
    this.offRegistry?.();
    this.offRegistry = registry.onLink((link, event) => {
      if (event === "added") this.attach(link);
      else this.detach(link.environmentId);
    });
  }

  attach(link: Link): void {
    const id = link.environmentId;
    const current = this.slots.get(id);
    if (current?.link === link) return;
    if (current) this.detach(id);
    const slot: Slot = { link, detach: [], githubInflight: null, linearInflight: null, linearKey: null };
    slot.detach = [link.onOpen(() => void this.load(slot))];
    this.slots.set(id, slot);
    if (link.connected) void this.load(slot);
  }

  detach(environmentId: string): void {
    const slot = this.slots.get(environmentId);
    if (!slot) return;
    for (const off of slot.detach) off();
    this.slots.delete(environmentId);
    const next = new Map(this.states);
    next.delete(environmentId);
    this.states = next;
    this.emit();
  }

  /** Test seam. */
  reset(): void {
    this.offRegistry?.();
    this.offRegistry = null;
    for (const slot of this.slots.values()) for (const off of slot.detach) off();
    this.slots.clear();
    this.states = new Map();
    this.emit();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (environmentId: string): InboxState => this.states.get(environmentId) ?? EMPTY;

  /** Every environment's inbox state, one map per change. */
  all = (): ReadonlyMap<string, InboxState> => this.states;

  /** The stored snapshot: SQLite on the host, never GitHub. */
  private async load(slot: Slot): Promise<void> {
    const id = slot.link.environmentId;
    try {
      const github = await slot.link.request<GithubInboxSnapshot>("github.inbox");
      this.set(id, { ...this.getSnapshot(id), github, githubLoaded: true, refreshing: github.refreshing });
    } catch {
      this.set(id, { ...this.getSnapshot(id), githubLoaded: true });
    }
  }

  /** Asks the host to fetch GitHub. The only network path for the inbox;
   *  only the open inbox view calls it. Concurrent calls share one request. */
  refreshGithub(environmentId: string, reason: GithubInboxRefreshReason): Promise<GithubInboxSnapshot | null> {
    const slot = this.slots.get(environmentId);
    if (slot?.githubInflight) return slot.githubInflight;
    if (!slot) return Promise.resolve(this.getSnapshot(environmentId).github);
    this.set(environmentId, { ...this.getSnapshot(environmentId), refreshing: true });
    slot.githubInflight = slot.link
      .request<GithubInboxSnapshot>("github.inboxRefresh", { reason })
      .then((github) => {
        this.set(environmentId, { ...this.getSnapshot(environmentId), github, githubLoaded: true, refreshing: false });
        return github;
      })
      .catch(() => {
        this.set(environmentId, { ...this.getSnapshot(environmentId), refreshing: false });
        return this.getSnapshot(environmentId).github;
      })
      .finally(() => {
        slot.githubInflight = null;
      });
    return slot.githubInflight;
  }

  /** The Linear list for a query on one host, fresh for a minute unless forced. */
  refreshLinear(
    environmentId: string,
    query: LinearInboxQuery,
    options: { force?: boolean } = {},
  ): Promise<InboxItem[]> {
    const slot = this.slots.get(environmentId);
    const key = linearQueryKey(query);
    const { linear } = this.getSnapshot(environmentId);
    if (!slot) return Promise.resolve(linear.items);
    if (
      !options.force &&
      key === slot.linearKey &&
      linear.fetchedAt !== null &&
      Date.now() - linear.fetchedAt < LINEAR_FRESH_MS
    ) {
      return Promise.resolve(linear.items);
    }
    if (slot.linearInflight && key === slot.linearKey) return slot.linearInflight;
    slot.linearKey = key;
    this.set(environmentId, { ...this.getSnapshot(environmentId), linear: { ...linear, loading: true } });
    const run = fetchLinearItems(environmentId, query)
      .then((items) => {
        if (slot.linearKey !== key) return items;
        this.set(environmentId, {
          ...this.getSnapshot(environmentId),
          linear: {
            items,
            fetchedAt: Date.now(),
            error: null,
            loading: false,
            assignedToMe: query.assignedToMe,
          },
        });
        return items;
      })
      .catch((err: unknown) => {
        if (slot.linearKey !== key) return [];
        const message = err instanceof Error ? err.message : String(err);
        const state = this.getSnapshot(environmentId);
        this.set(environmentId, { ...state, linear: { ...state.linear, error: message, loading: false } });
        return state.linear.items;
      })
      .finally(() => {
        if (slot.linearInflight === run) slot.linearInflight = null;
      });
    slot.linearInflight = run;
    return run;
  }

  private set(environmentId: string, next: InboxState): void {
    const states = new Map(this.states);
    states.set(environmentId, next);
    this.states = states;
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

async function fetchLinearItems(environmentId: string, query: LinearInboxQuery): Promise<InboxItem[]> {
  if (!(await linearConnected(environmentId)).connected) return [];
  const hiddenIds = query.hiddenTeamIds ?? loadHiddenLinearTeamIds();
  let teamIds: string[] | null = null;
  if (hiddenIds.length > 0) {
    teamIds = linearTeamIdsForFetch(await listLinearTeams(environmentId), hiddenIds);
    if (teamIds?.length === 0) return [];
  }
  const issues = await listLinearIssues(environmentId, {
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

export function useInbox(environmentId: string): InboxState {
  return useSyncExternalStore(
    inboxStore.subscribe,
    () => inboxStore.getSnapshot(environmentId),
    () => inboxStore.getSnapshot(environmentId),
  );
}
