import { loadProjectPlan } from "./projectPlan";
import { useSyncExternalStore } from "react";
import type { BuildRun, RemoteStatus } from "@server/shared/build";
import type {
  BranchList,
  CommitInfo,
  CompareResult,
  MergeResult,
} from "@server/shared/domain";
import { registry } from "./connection";
import { linkOfProject, linkOfWorkspace } from "./tcserver/projects";
import { workspaceStore } from "./tcserver/workspaces";

/**
 * Data behind the project right rail (Branch and Build tabs), keyed by
 * the explicit project id every caller names — never a "selected"
 * project. Fed by `build` and `sync` pushes; each slice is fetched when
 * a panel mounts and dropped when the socket reconnects, so a re-opened
 * panel replays from the server rather than from a stale cache.
 */

export const BUILD_LOG_CAP = 3000;

export interface BuildState {
  run: BuildRun | null;
  lines: string[];
}

export interface SyncProgress {
  branch: string;
  line: string;
  percent: number | null;
}

interface State {
  /** null: the host has no branch to compare against. */
  compares: Record<string, CompareResult | null>;
  builds: Record<string, BuildState>;
  syncs: Record<string, SyncProgress>;
  /** keyed by workspace id: branches are a repo property */
  branches: Record<string, BranchList>;
  logs: Record<string, CommitInfo[]>;
}

const EMPTY: State = { compares: {}, builds: {}, syncs: {}, branches: {}, logs: {} };
let state: State = EMPTY;
const listeners = new Set<() => void>();

function set(patch: Partial<State>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function without<T>(map: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _dropped, ...rest } = map;
  return rest;
}

/** Test hook: the raw snapshot. */
export function railSnapshot(): State {
  return state;
}

/** Test hook. */
export function resetRailStore(): void {
  set(EMPTY);
}

// ── pushes ────────────────────────────────────────────────────────────

/** A `build` push: a new run id replaces the log, the same id appends. */
export function applyBuildPush(projectId: string, run: BuildRun, lines?: string[]): void {
  const prev = state.builds[projectId];
  const fresh = !prev || prev.run?.id !== run.id;
  const merged = fresh ? (lines ?? []) : lines?.length ? [...prev.lines, ...lines] : prev.lines;
  const capped = merged.length > BUILD_LOG_CAP ? merged.slice(merged.length - BUILD_LOG_CAP) : merged;
  set({ builds: { ...state.builds, [projectId]: { run, lines: capped } } });
}

export function applySyncPush(projectId: string, sync: SyncProgress): void {
  set({ syncs: { ...state.syncs, [projectId]: sync } });
}

export function clearSync(projectId: string): void {
  if (!state.syncs[projectId]) return;
  set({ syncs: without(state.syncs, projectId) });
}

/** Forget what one environment's socket told us: its projects' compares,
 *  logs, builds and syncs, and its workspaces' branch lists. */
export function clearEnvironment(environmentId: string): void {
  const ofEnv = (projectId: string): boolean => workspaceStore.project(projectId)?.environmentId === environmentId;
  const drop = <T>(record: Record<string, T>, keep: (id: string) => boolean): Record<string, T> =>
    Object.fromEntries(Object.entries(record).filter(([id]) => keep(id)));
  set({
    compares: drop(state.compares, (id) => !ofEnv(id)),
    logs: drop(state.logs, (id) => !ofEnv(id)),
    builds: drop(state.builds, (id) => !ofEnv(id)),
    syncs: drop(state.syncs, (id) => !ofEnv(id)),
    branches: drop(state.branches, (id) => workspaceStore.workspace(id)?.environmentId !== environmentId),
  });
}

registry.onLink((link, event) => {
  if (event === "removed") return clearEnvironment(link.environmentId);
  link.onPush((push) => {
    if (push.push === "build") applyBuildPush(push.projectId, push.run, push.lines);
    else if (push.push === "builds") {
      for (const item of push.items) applyBuildPush(item.projectId, item.run, item.lines);
    } else if (push.push === "sync") {
      applySyncPush(push.projectId, { branch: push.branch, line: push.line, percent: push.percent });
    }
  });
  // Subscriptions and buffered logs live on the connection; a fresh socket
  // starts from what the server replays.
  link.onOpen(() => clearEnvironment(link.environmentId));
});

// ── fetches ───────────────────────────────────────────────────────────

/** null when no target was named and the host has none to default to. */
export async function fetchCompare(projectId: string, target?: string): Promise<CompareResult | null> {
  const compare = (await linkOfProject(projectId).request("project.compare", {
    projectId,
    ...(target ? { target } : {}),
  })) as CompareResult | null;
  set({ compares: { ...state.compares, [projectId]: compare } });
  return compare;
}

export function dropCompare(projectId: string): void {
  if (!(projectId in state.compares)) return;
  set({ compares: without(state.compares, projectId) });
}

export async function fetchBranches(workspaceId: string): Promise<BranchList> {
  const list = (await linkOfWorkspace(workspaceId).request("project.branches", { workspaceId })) as BranchList;
  set({ branches: { ...state.branches, [workspaceId]: list } });
  return list;
}

export async function fetchLog(projectId: string, limit = 20): Promise<CommitInfo[]> {
  const log = (await linkOfProject(projectId).request("project.log", { projectId, limit })) as CommitInfo[];
  set({ logs: { ...state.logs, [projectId]: log } });
  return log;
}

export async function mergeFrom(
  projectId: string,
  target: string,
  mode: "merge" | "rebase",
): Promise<MergeResult> {
  return (await linkOfProject(projectId).request("project.mergeFrom", { projectId, target, mode })) as MergeResult;
}

export async function mergeInto(projectId: string, target: string): Promise<MergeResult> {
  const result = (await linkOfProject(projectId).request("project.mergeInto", { projectId, target })) as MergeResult;
  // A landed build ticks the milestone its thread works in the project plan.
  if (result.ok) void loadProjectPlan(projectId);
  return result;
}

/** Last run and its buffered log, replayed into the store. */
export async function fetchBuildStatus(projectId: string): Promise<void> {
  const status = (await linkOfProject(projectId).request("build.status", { projectId })) as {
    run: BuildRun | null;
    lines: string[];
  } | null;
  set({
    builds: {
      ...state.builds,
      [projectId]: { run: status?.run ?? null, lines: status?.lines ?? [] },
    },
  });
}

export async function runBuild(projectId: string, branch?: string): Promise<void> {
  await linkOfProject(projectId).request("build.run", { projectId, ...(branch ? { branch } : {}) });
}

export async function cancelBuild(projectId: string): Promise<void> {
  await linkOfProject(projectId).request("build.cancel", { projectId });
}

/** Fetch origin/<branch> (progress lands in `syncs`) and fast-forward. */
export async function pullBranch(projectId: string, branch?: string): Promise<RemoteStatus | null> {
  try {
    return (await linkOfProject(projectId).request("build.pull", {
      projectId,
      ...(branch ? { branch } : {}),
    })) as RemoteStatus | null;
  } finally {
    clearSync(projectId);
  }
}

// ── hooks ─────────────────────────────────────────────────────────────

/** undefined while loading; null when there is no branch to compare against. */
export function useCompare(projectId: string): CompareResult | null | undefined {
  return useSyncExternalStore(subscribe, () => state.compares[projectId], () => undefined);
}

export function useBuild(projectId: string): BuildState | undefined {
  return useSyncExternalStore(subscribe, () => state.builds[projectId], () => undefined);
}

export function useSync(projectId: string): SyncProgress | undefined {
  return useSyncExternalStore(subscribe, () => state.syncs[projectId], () => undefined);
}

export function useBranchList(workspaceId: string | null): BranchList | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (workspaceId ? state.branches[workspaceId] : undefined),
    () => undefined,
  );
}

export function useGitLog(projectId: string): CommitInfo[] | undefined {
  return useSyncExternalStore(subscribe, () => state.logs[projectId], () => undefined);
}
