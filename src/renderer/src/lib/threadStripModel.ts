import type { BackgroundWork } from "@shared/events";
import { leadDetail } from "@shared/statusWords";
import { watchPhrase } from "@shared/watch";
import { threadStateOf, type ThreadState } from "../components/ui/status";
import type { Catalog } from "./projectContext";
import { workspaceIdOf } from "./tcserver/workspaces";
import type { SessionMeta, SessionStatus, ThreadType } from "./tcserver/types";

/**
 * temp-code's thread strip rules, as pure functions over server metas.
 * The strip shows the selected project's root threads — every one of them,
 * open in a tab or not — or, with no project selected, the scope's loose
 * chats (the workspace's Chats, or the home's). Live chips (working,
 * paused, recoverable, needs-you, unread, plan-ready) hold the top row,
 * the rest settle on the shelf; each row is freshest activity first.
 * Being open or selected earns nothing, and a blank thread is not forced
 * live: once looked at it goes to the shelf like any other.
 */

export type StripThread = Pick<
  SessionMeta,
  "id" | "status" | "updatedAt" | "projectId" | "parentId" | "archived"
> &
  Partial<
    Pick<
      SessionMeta,
      "treeHasLiveWork" | "treeHasPaused" | "treeCanContinue" | "masterId" | "workspaceId" | "cwd"
    >
  > & {
    /** Minted locally, not on the server yet; always live. */
    draft?: boolean;
  };

export type SeenMap = Record<string, number>;
export type ReadyMap = Record<string, boolean>;

/** A root thread of a master's batch (CLAUDE.md "Master threads"): it
 *  lives on the master's board and never on the strip or its shelf. */
export function isBatchChild(thread: Pick<StripThread, "parentId" | "masterId">): boolean {
  return !thread.parentId && !!thread.masterId;
}

/** A project id, or every copy of a linked project (CLAUDE.md "One project across hosts"). */
export type ProjectScope = string | ReadonlySet<string> | null;

export function inProjectScope(projectId: string | null | undefined, scope: ProjectScope): boolean {
  if (!projectId || !scope) return false;
  return typeof scope === "string" ? projectId === scope : scope.has(projectId);
}

/** Root, unarchived threads of `projectId` (or of every copy in the set), freshest first.
 *  No project → nothing (the loose scope is `stripRootThreads`'s); a batch child never sits here. */
export function projectRootThreads<T extends StripThread>(
  threads: readonly T[],
  projectId: ProjectScope,
): T[] {
  if (!projectId) return [];
  return threads
    .filter((t) => inProjectScope(t.projectId, projectId) && !t.parentId && !t.archived && !isBatchChild(t))
    .sort(freshestFirst);
}

/** What a strip holds: a project's roots (every copy of a linked one), or
 *  the loose chats of a workspace (`loose: null`: the home's, outside every
 *  workspace). */
export type StripScope =
  | { project: ProjectScope }
  | { loose: string | null; catalog: Catalog };

/** The scope's root, unarchived threads, freshest first; never a batch child. */
export function stripRootThreads<T extends StripThread>(threads: readonly T[], scope: StripScope): T[] {
  if ("project" in scope) return projectRootThreads(threads, scope.project);
  const { catalog, loose } = scope;
  return threads
    .filter(
      (t) =>
        !t.projectId &&
        !t.parentId &&
        !t.archived &&
        !isBatchChild(t) &&
        workspaceIdOf({ ...t, cwd: t.cwd ?? "" }, catalog.projects, catalog.workspaces) === loose,
    )
    .sort(freshestFirst);
}

/** Archived roots of `projectId`, freshest first, for the shelf. */
export function archivedRootThreads<T extends StripThread>(
  threads: readonly T[],
  projectId: ProjectScope,
): T[] {
  if (!projectId) return [];
  return threads
    .filter((t) => inProjectScope(t.projectId, projectId) && !t.parentId && t.archived && !isBatchChild(t))
    .sort(freshestFirst);
}

/** `floor`: threads with no lastSeen entry count as seen up to this time. */
export function isUnread(
  t: Pick<StripThread, "id" | "updatedAt">,
  lastSeen: SeenMap,
  floor = 0,
): boolean {
  return t.updatedAt > (lastSeen[t.id] ?? floor);
}

/** temp-code's live rule: anything not settled-and-seen. `done` settles
 *  like `idle` (the server's terminal status for a finished run). */
/** What the live rule reads; every StripThread and ThreadRow has it. */
export type LiveInput = Pick<StripThread, "id" | "status" | "updatedAt"> &
  Partial<Pick<StripThread, "treeHasLiveWork" | "treeHasPaused" | "treeCanContinue" | "draft">>;

export function isLiveThread(
  t: LiveInput,
  lastSeen: SeenMap,
  planReady: ReadyMap,
  floor = 0,
): boolean {
  return (
    !!t.draft ||
    (t.status !== "idle" && t.status !== "done") ||
    !!t.treeHasLiveWork ||
    !!t.treeHasPaused ||
    !!t.treeCanContinue ||
    isUnread(t, lastSeen, floor) ||
    !!planReady[t.id]
  );
}

export function splitThreads<T extends StripThread>(
  threads: readonly T[],
  lastSeen: SeenMap,
  planReady: ReadyMap,
  floor = 0,
): { live: T[]; dormant: T[] } {
  const live: T[] = [];
  const dormant: T[] = [];
  for (const t of [...threads].sort(freshestFirst))
    (isLiveThread(t, lastSeen, planReady, floor) ? live : dormant).push(t);
  return { live, dormant };
}

/** The roots "Archive dormant threads" takes: settled, seen, nothing live
 *  or paused or recoverable in the tree, not pinned, and not a planning
 *  thread holding a plan (its readiness is polled elsewhere, so it is
 *  spared rather than guessed at). Working, needs-you, unread and pinned
 *  roots are never touched. */
export function dormantThreads<
  T extends LiveInput & Partial<Pick<SessionMeta, "pinned" | "threadType" | "planPath">>,
>(
  threads: readonly T[],
  lastSeen: SeenMap,
  floor = 0,
  exclude: ReadonlySet<string> = NONE,
): T[] {
  return threads.filter(
    (t) =>
      !exclude.has(t.id) &&
      !t.pinned &&
      !(t.threadType === "planning" && t.planPath) &&
      !isLiveThread(t, lastSeen, {}, floor),
  );
}

const NONE: ReadonlySet<string> = new Set();

/** The focused session's whole thread — its root and every descendant —
 *  which "Archive dormant threads" spares: the thread on screen is in use
 *  however settled it looks. Empty when nothing is focused. */
export function focusedTree(
  metas: readonly Pick<SessionMeta, "id" | "parentId">[],
  focusedId: string | null | undefined,
): Set<string> {
  const tree = new Set<string>();
  if (!focusedId) return tree;
  const byId = new Map(metas.map((m) => [m.id, m]));
  let root = byId.get(focusedId);
  while (root?.parentId && byId.has(root.parentId)) root = byId.get(root.parentId);
  tree.add(root?.id ?? focusedId);
  for (let grew = true; grew; ) {
    grew = false;
    for (const m of metas)
      if (m.parentId && tree.has(m.parentId) && !tree.has(m.id)) {
        tree.add(m.id);
        grew = true;
      }
  }
  return tree;
}

/** One "Archive N dormant …" row per thread type present. */
export type DormantGroup<T> = { type: ThreadType; threads: T[]; label: string };

const DORMANT_TYPE_ORDER: readonly ThreadType[] = [
  "chat",
  "planning",
  "implementation",
  "orchestration",
  "research",
];

const DORMANT_NOUNS: Record<ThreadType, readonly [one: string, many: string]> = {
  chat: ["chat", "chats"],
  planning: ["plan", "plans"],
  "project-plan": ["project plan", "project plans"],
  implementation: ["implementation thread", "implementation threads"],
  orchestration: ["orchestration", "orchestrations"],
  research: ["research thread", "research threads"],
};

/** The per-type slices of `dormantThreads`, in chooser order, only for types
 *  present. One type alone is left out: its row would repeat the all-types
 *  row above it. A root with no type counts as a chat. */
export function dormantByType<T extends { threadType?: ThreadType | null }>(
  dormant: readonly T[],
): DormantGroup<T>[] {
  const groups = DORMANT_TYPE_ORDER.flatMap((type) => {
    const threads = dormant.filter((t) => (t.threadType ?? "chat") === type);
    if (threads.length === 0) return [];
    const noun = DORMANT_NOUNS[type][threads.length === 1 ? 0 : 1];
    return [{ type, threads, label: `Archive ${threads.length} dormant ${noun}` }];
  });
  return groups.length > 1 ? groups : [];
}

/** What every thread status row reads: a chip's meta and a tab's thread both give it. */
export type ThreadStatusInput = {
  status: SessionStatus | null | undefined;
  treeHasPaused?: boolean;
  treeCanContinue?: boolean;
  /** The host's activity line ("Running bun", "Queued · 3rd in line", "Waiting on …"). */
  activity?: string | null;
  tasks?: { done: number; total: number } | null;
  /** The host's one-line failure verdict. */
  failure?: string | null;
  planReady?: boolean;
  /** The undecided approval's label ("Bash: bun test"), when the transcript is loaded. */
  waitingOn?: string | null;
  /** An undecided question in the transcript. */
  asking?: boolean;
  background?: BackgroundWork | null;
};

/** A thread's state in the one vocabulary, what it is about, and its round's tally. */
export type ThreadStatus = { state: ThreadState; detail: string | null; tally: string | null };

/**
 * The one decision of what a thread's status row says (docs/DESIGN.md
 * "Status vocabulary"): `threadStateOf`, plus the tree's overrides (a paused
 * descendant reads paused, a recoverable failure in the tree failed) and the
 * detail. A detail starts lower-case, never ends in a full stop and never
 * repeats the word.
 */
export function threadStatus(input: ThreadStatusInput): ThreadStatus {
  const { status } = input;
  if (input.treeHasPaused) return { state: "paused", detail: null, tally: null };
  // The host clears treeCanContinue while the tree has live work.
  if (input.treeCanContinue)
    return { state: "failed", detail: lowerFirst(input.failure), tally: null };
  const own = threadStateOf(status, { planReady: input.planReady });
  // A settled parent whose subagents still work is watching them, whatever each one does.
  const state = settledWithAgents(own, input.background) ? "watching" : own;
  const none = { state, detail: null, tally: null };
  switch (state) {
    case "working": {
      const detail = lowerFirst(input.activity) ?? (status === "starting" ? "starting" : null);
      const tally = input.tasks ? `${input.tasks.done}/${input.tasks.total}` : null;
      return { state, detail, tally };
    }
    case "waiting":
      if (input.waitingOn) return { state, detail: `approve ${input.waitingOn}`, tally: null };
      return { state, detail: input.asking ? "answer a question" : null, tally: null };
    case "watching":
      return {
        state,
        // A master whose batch cannot end says why first (the host's
        // `decorate`: "Blocked: A errored"), ahead of what it watches.
        detail:
          (input.activity?.trim().startsWith("Blocked:") ? lowerFirst(input.activity) : null) ||
          lowerFirst(watchPhrase(input.background)) ||
          lowerFirst(after(input.activity, "Waiting on")) ||
          "background work",
        tally: null,
      };
    case "queued":
      return { state, detail: lowerFirst(after(input.activity, "Queued")), tally: null };
    case "stopped":
      return { state, detail: "the harness is gone", tally: null };
    case "failed":
      return { state, detail: lowerFirst(input.failure), tally: null };
    default:
      return none;
  }
}

/** Idle or done (never paused, failed or plan-ready) with live subagents under it. */
export function settledWithAgents(state: ThreadState, background: BackgroundWork | null | undefined): boolean {
  return (state === "idle" || state === "done") && !!background?.agents.length;
}

/** The host's line past its leading word ("Queued  3rd in line" → "3rd in line"; statusWords.ts `leadDetail`, the old dot read too); null when it says nothing more. */
function after(line: string | null | undefined, lead: string): string | null {
  return leadDetail(line, lead);
}

/** A detail as the vocabulary writes it: lower-case first letter (an acronym keeps its case), no trailing full stop. */
export function lowerFirst(text: string | null | undefined): string | null {
  const t = text?.trim().replace(/\.$/, "");
  if (!t) return null;
  const head = t.split(/\s/, 1)[0];
  if (head.length > 1 && head === head.toUpperCase() && /[A-Z]/.test(head)) return t;
  return t[0].toLowerCase() + t.slice(1);
}

/** Does the state draw a mark at rest: not when it would only say "nothing is happening". */
export function marksAtRest(state: ThreadState): boolean {
  return state !== "idle" && state !== "done";
}

/** An undecided question in a transcript (the question card's pending case). */
export function hasPendingQuestion(blocks: readonly { question?: { answers?: unknown } | null }[]): boolean {
  return blocks.some((b) => b.question != null && b.question.answers === undefined);
}

/** Roots with live work anywhere in their tree — what Pause All pauses. */
export function runningRoots<T extends StripThread>(threads: readonly T[]): T[] {
  return threads.filter((t) => !t.parentId && !t.archived && !!t.treeHasLiveWork);
}

function freshestFirst(a: StripThread, b: StripThread): number {
  return b.updatedAt - a.updatedAt;
}
