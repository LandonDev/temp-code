import { useMemo } from "react";
import { unwrapBashCommand } from "@server/shared/bashMarks";
import type { BackgroundTaskKind } from "@server/shared/events";
import type { MacBridgeRequest } from "@server/shared/contract-macbridge";
import { STALE_WATCH_MS, isStaleWatch } from "@server/shared/watch";
import { stopLiveServer, useLiveDevServers, type LiveServer } from "./devServers";
import { stopMacBridgeAll, useMacBridgeRunning } from "./macBridge";
import { killBackground, stopTask } from "./tcserver/commands";
import { useSessionMeta, useSessionMetas } from "./tcserver/store";
import type { SessionMeta } from "./tcserver/types";

/**
 * A thread's background work as the right panel's Activity section and the
 * watching strip read it: the meta's `background` (CLAUDE.md "Background
 * work and watching") joined with the thread's dev servers and its running
 * Mac calls. One row per task, one summary row for the live subagents (the
 * Agents section lists them), one for a master's batch.
 */

export type ActivityKind = BackgroundTaskKind | "subagents" | "batch" | "dev" | "mac";

export type StopTarget =
  | { type: "task"; sessionId: string; taskId: string }
  | { type: "dev"; server: LiveServer }
  | { type: "mac"; request: MacBridgeRequest };

export interface ActivityRow {
  key: string;
  kind: ActivityKind;
  label: string;
  /** A shell task's command, when it says more than the label. */
  detail?: string;
  since: number;
  stop?: StopTarget;
  /** What a click opens: the task's output, the Agents section, the dev servers pane. */
  open?: "log" | "agents" | "dev";
  /** `log` rows: the task whose output session.taskLog reads. */
  taskId?: string;
  /** `dev` rows: the dev servers pane's key for the server. */
  devKey?: string;
}

export interface ActivitySources {
  meta: Pick<SessionMeta, "id" | "status" | "background">;
  /** The live subagents' metas (background.agents), for the summary row's age. */
  agents: Pick<SessionMeta, "busySince" | "createdAt">[];
  /** Dev servers the thread or one of its subagents opened. */
  devServers: LiveServer[];
  /** The thread's Mac calls in flight. */
  macCalls: MacBridgeRequest[];
}

/** Only a background shell writes an output file the host can tail; a monitor's events go to the model alone. */
const LOG_KINDS: ReadonlySet<ActivityKind> = new Set(["shell"]);
const upperFirst = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** The rows, subagents and batch first, then oldest first. */
export function activityRows(src: ActivitySources): ActivityRow[] {
  const bg = src.meta.background;
  const head: ActivityRow[] = [];
  const rest: ActivityRow[] = [];
  if (bg?.agents.length) {
    const since = Math.min(...src.agents.map((a) => a.busySince ?? a.createdAt));
    const n = bg.agents.length;
    head.push({
      key: "subagents",
      kind: "subagents",
      label: `${n} ${n === 1 ? "subagent" : "subagents"}`,
      since: Number.isFinite(since) ? since : (bg.watchingSince ?? Date.now()),
      open: "agents",
    });
  }
  // A master watching with every batch thread done and nothing else live waits on its batch's steps
  // (a finished batch keeps its tally, so its own monitor alone is no steps row).
  const steps = src.meta.status === "watching" && !bg?.tasks.length && !bg?.agents.length;
  if (bg?.batch && (bg.batch.out > 0 || steps)) {
    head.push({
      key: "batch",
      kind: "batch",
      label: bg.batch.out > 0 ? `${bg.batch.out} of ${bg.batch.total} batch threads` : "Batch steps",
      since: bg.watchingSince ?? Date.now(),
    });
  }
  for (const t of bg?.tasks ?? []) {
    const cron = t.kind === "cron";
    // The host's guard marks a call's shell; the row shows the command as written.
    const command = t.command ? unwrapBashCommand(t.command) : undefined;
    rest.push({
      key: `task:${t.id}`,
      kind: t.kind,
      label: cron ? upperFirst(t.label) : t.label,
      ...(command && command !== t.label ? { detail: command } : {}),
      since: t.startedAt,
      ...(cron ? {} : { stop: { type: "task" as const, sessionId: src.meta.id, taskId: t.id } }),
      ...(LOG_KINDS.has(t.kind) ? { open: "log" as const, taskId: t.id } : {}),
    });
  }
  for (const server of src.devServers) {
    rest.push({
      key: `dev:${server.key}`,
      kind: "dev",
      label: server.port ? `Dev server :${server.port.number}` : server.title,
      since: server.startedAt,
      stop: { type: "dev", server },
      open: "dev",
      devKey: server.key,
    });
  }
  for (const request of src.macCalls) {
    if (request.status !== "running") continue;
    rest.push({
      key: `mac:${request.id}`,
      kind: "mac",
      label: request.command ?? "Mac command",
      since: request.createdAt,
      stop: { type: "mac", request },
    });
  }
  rest.sort((a, b) => a.since - b.since);
  return [...head, ...rest];
}

/** A row's age turns amber once its thread watches stale and the row is that old: tasks, crons and the batch only (the rest have their own liveness). */
export function rowStale(row: ActivityRow, meta: Pick<SessionMeta, "status" | "background">, now: number): boolean {
  if (row.kind === "subagents" || row.kind === "dev" || row.kind === "mac") return false;
  return isStaleWatch(meta, now) && now - row.since > STALE_WATCH_MS;
}

/** The Activity section exists only with rows to show. */
export function hasActivity(rows: readonly ActivityRow[]): boolean {
  return rows.length > 0;
}

/** The dev servers of a thread's tree: a ledger row by the thread that opened it, a run started from the pane by the thread on screen then. */
export function threadServers(servers: readonly LiveServer[], tree: ReadonlySet<string>): LiveServer[] {
  return servers.filter((s) => tree.has(s.resource?.sessionId ?? s.sessionId ?? ""));
}

/** Every session in the thread's tree, the thread first. */
function treeIds(rootId: string, metas: readonly SessionMeta[]): Set<string> {
  const ids = new Set([rootId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const m of metas) {
      if (m.parentId && ids.has(m.parentId) && !ids.has(m.id)) {
        ids.add(m.id);
        grew = true;
      }
    }
  }
  return ids;
}

/** The thread's Activity rows, live. */
export function useActivity(threadId: string): { rows: ActivityRow[]; meta: SessionMeta | null } {
  const meta = useSessionMeta(threadId);
  const metas = useSessionMetas();
  const servers = useLiveDevServers();
  const macCalls = useMacBridgeRunning({ environmentId: meta?.environmentId, sessionId: threadId });
  const rows = useMemo(() => {
    if (!meta) return [];
    const agentIds = new Set(meta.background?.agents ?? []);
    const tree = treeIds(threadId, metas);
    return activityRows({
      meta,
      agents: metas.filter((m) => agentIds.has(m.id)),
      devServers: threadServers(servers, tree),
      macCalls,
    });
  }, [macCalls, meta, metas, servers, threadId]);
  return { rows, meta };
}

/** A row's Stop. */
export function stopActivity(row: ActivityRow): Promise<void> {
  const stop = row.stop;
  if (!stop) return Promise.resolve();
  if (stop.type === "task") return stopTask(stop.sessionId, stop.taskId);
  if (stop.type === "dev") return stopLiveServer(stop.server);
  return stopMacBridgeAll([stop.request]);
}

/** Stop everything a watching thread waits on (session.killBackground). */
export function stopAll(sessionId: string): Promise<void> {
  return killBackground(sessionId);
}
