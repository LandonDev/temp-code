import { invokeOn } from "./native";

export type LinearTeam = {
  id: string;
  key: string;
  name: string;
};

export type LinearIssue = {
  provider: "linear";
  kind: "linear";
  id: string;
  identifier: string;
  number: number;
  title: string;
  url: string;
  state: string;
  stateType: string;
  updatedAt: string;
  labels: { name: string; color: string }[];
  assignees: { login: string; avatarUrl?: string }[];
  draft: boolean;
  repo: string;
  teamId: string;
  teamName: string;
  projectPath: string;
};

export type LinearIssueDetails = {
  body: string;
  author: string;
  authorAvatarUrl?: string;
};

export type LinearIssueComment = {
  id: string;
  kind: string;
  author: string;
  authorAvatarUrl?: string;
  body: string;
  createdAt: string;
  url: string;
  state: string;
  path: string;
  line: number | null;
  resolved: boolean;
  threadId: string;
  replies: LinearIssueComment[];
};

export type LinearIssueThread = {
  comments: LinearIssueComment[];
  truncated: boolean;
  reviewDecision: string;
  baseRefName: string;
  headRefName: string;
};

export type LinearStatus = {
  connected: boolean;
};

const TEAM_IDS_KEY = "monocode.linearHiddenTeams";
export const LINEAR_CHANGE_EVENT = "monocode:linear-change";

const detailsById = new Map<string, LinearIssueDetails>();
const threadById = new Map<string, LinearIssueThread>();
const threadInflight = new Map<string, Promise<LinearIssueThread>>();

export function linearConnected(environmentId: string): Promise<LinearStatus> {
  return invokeOn<LinearStatus>(environmentId, "linear_status");
}

export function saveLinearToken(environmentId: string, token: string): Promise<LinearStatus> {
  return invokeOn<LinearStatus>(environmentId, "linear_set_token", { token: token.trim() });
}

export function disconnectLinear(environmentId: string): Promise<LinearStatus> {
  return invokeOn<LinearStatus>(environmentId, "linear_set_token", { token: "" });
}

export function listLinearTeams(environmentId: string): Promise<LinearTeam[]> {
  return invokeOn<LinearTeam[]>(environmentId, "linear_list_teams");
}

/** `null` means do not filter by team. `[]` means every known team is hidden. */
export function linearTeamIdsForFetch(
  teams: readonly LinearTeam[],
  hiddenIds: readonly string[],
): string[] | null {
  if (hiddenIds.length === 0) return null;
  const hidden = new Set(hiddenIds);
  const visible = teams
    .filter((team) => !hidden.has(team.id))
    .map((team) => team.id);
  if (visible.length === teams.length) return null;
  return visible;
}

export function listLinearIssues(environmentId: string, query: {
  assignedToMe: boolean;
  state: "open" | "all";
  teamIds: string[];
}): Promise<LinearIssue[]> {
  return invokeOn<LinearIssue[]>(environmentId, "linear_list_issues", {
    assignedToMe: query.assignedToMe,
    state: query.state,
    teamIds: query.teamIds,
  });
}

// Caches key by host and id: two hosts may both know an issue.
const cacheKey = (environmentId: string, id: string): string => `${environmentId}|${id}`;

export function peekLinearIssueDetails(environmentId: string, id: string): LinearIssueDetails | null {
  return detailsById.get(cacheKey(environmentId, id)) ?? null;
}

export async function linearIssueDetails(environmentId: string, id: string,
): Promise<LinearIssueDetails> {
  const details = await invokeOn<LinearIssueDetails>(environmentId, "linear_issue_details", {
    id,
  });
  detailsById.set(cacheKey(environmentId, id), details);
  return details;
}

export function peekLinearIssueThread(environmentId: string, id: string): LinearIssueThread | null {
  return threadById.get(cacheKey(environmentId, id)) ?? null;
}

export async function linearIssueThread(environmentId: string, id: string,
  options?: { force?: boolean },
): Promise<LinearIssueThread> {
  const key = cacheKey(environmentId, id);
  if (options?.force) {
    threadById.delete(key);
    threadInflight.delete(key);
  }
  const pending = threadInflight.get(key);
  if (pending) return pending;
  const promise = invokeOn<LinearIssueThread>(environmentId, "linear_issue_thread", { id })
    .then((thread) => {
      threadById.set(key, thread);
      return thread;
    })
    .finally(() => {
      if (threadInflight.get(key) === promise) threadInflight.delete(key);
    });
  threadInflight.set(key, promise);
  return promise;
}

export async function linearIssueComment(environmentId: string, id: string,
  body: string,
  options?: { parentId?: string },
): Promise<string> {
  const url = await invokeOn<string>(environmentId, "linear_issue_comment", {
    id,
    body: body.trim(),
    parentId: options?.parentId?.trim() ?? "",
  });
  threadById.delete(cacheKey(environmentId, id));
  threadInflight.delete(cacheKey(environmentId, id));
  return url;
}

export function loadHiddenLinearTeamIds(): string[] {
  try {
    const raw = localStorage.getItem(TEAM_IDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    );
  } catch {
    return [];
  }
}

export function saveHiddenLinearTeamIds(ids: string[]) {
  try {
    localStorage.setItem(TEAM_IDS_KEY, JSON.stringify(ids));
  } catch {
    // private mode / quota
  }
  notifyLinearChange();
}

export function notifyLinearChange() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(LINEAR_CHANGE_EVENT));
}
