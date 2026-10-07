import type { AgentEvent } from "./types";

/**
 * The task list a thread is working, folded from its own tool calls — the
 * client copy of the server's todos.ts, so the tab tally and the board
 * count the same tasks. TodoWrite/update_plan replace the list per call;
 * the SDK task tools (TaskCreate/TaskUpdate) build it up, addressing
 * items by the "#3" the create call's result reported.
 *
 * Everything here mutates the ThreadState it is handed at the top level
 * only (arrays and records are replaced, never edited in place), so the
 * fold can hand it a shallow clone and keep React's identity checks.
 */

export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoItem = { content: string; status: TodoStatus };
export type UsageMark = { round: number; todo: number; input?: number; output?: number };
export type ResearchSource = {
  callId: string;
  url?: string;
  query?: string;
  agentId: string;
  agentLabel: string;
  title?: string;
  /** the one-line finding this source supports (a cite_source call) */
  claim?: string;
  ts: number;
};

export type ThreadState = {
  /** Latest todo list (TodoWrite / update_plan / TaskCreate+TaskUpdate). */
  todos: TodoItem[];
  /** Index of the in-progress todo; -1 before the first list. */
  activeTodo: number;
  /** Current round (0-based); bumps when a user message opens a new pass. */
  round: number;
  /** Todo list of each finished round, by round index. */
  rounds: TodoItem[][];
  /** Cumulative session cost when each round archived. */
  costs: (number | undefined)[];
  /** Cumulative token snapshots keyed to the task active when they landed. */
  usage: UsageMark[];
  /** Cumulative session cost, from the latest turn-complete. */
  cost?: number;
  /** The last run ended because the user hit Stop. */
  stopped: boolean;
  /** The harness is squeezing the conversation right now. */
  compacting: boolean;
  /** research-source rows, whole, for the research board. */
  sources: ResearchSource[];
  /** Child session ids this thread spawned. */
  agents: string[];
  turnOpen: boolean;
  sawUser: boolean;
  /** Inside a completed-turn pass — blocks born now get the pass flag. */
  inPass: boolean;
  /** "3" (from "Task #3 created") → its index in the list. */
  taskIds: Record<string, number>;
  /** Pending TaskCreate calls waiting for the result that names them. */
  taskByCall: Record<string, number>;
  /** Task calls already folded (re-delivery guard). */
  taskSeen: Record<string, true>;
};

export function emptyThread(): ThreadState {
  return {
    todos: [],
    activeTodo: -1,
    round: 0,
    rounds: [],
    costs: [],
    usage: [],
    stopped: false,
    compacting: false,
    sources: [],
    agents: [],
    turnOpen: false,
    sawUser: false,
    inPass: false,
    taskIds: {},
    taskByCall: {},
    taskSeen: {},
  };
}

/** A turn silent this long is dead, not open (crash, kill). */
export const STALE_TURN_MS = 10 * 60_000;
/** How long unfinished work stays warm enough to resume. */
export const RESUME_WINDOW_MS = 30 * 60_000;

/**
 * A user message on a CLOSED turn starts a new round: the old board's
 * todos archive and the active-task pointer resets. Explicit beats
 * inferred: a send stamped with newPass decides directly; unstamped sends
 * fall back to "unfinished and warm means resume".
 */
export function beginTurn(
  s: ThreadState,
  ts: number | undefined,
  lastTs: number | undefined,
  newPass?: boolean,
): void {
  const gap = lastTs !== undefined && ts !== undefined ? ts - lastTs : 0;
  const stale = s.turnOpen && gap > STALE_TURN_MS;
  const unfinished = s.todos.length > 0 && s.todos.some((t) => t.status !== "completed");
  const resuming = unfinished && gap <= RESUME_WINDOW_MS;
  const wantNew =
    newPass !== undefined ? newPass && (!s.turnOpen || stale) : (!s.turnOpen || stale) && !resuming;
  if (wantNew && s.sawUser) {
    s.rounds = [...s.rounds, s.todos];
    s.costs = [...s.costs, s.cost];
    s.todos = [];
    s.activeTodo = -1;
    s.round += 1;
    s.taskIds = {};
    s.taskByCall = {};
    s.taskSeen = {};
  }
  s.turnOpen = true;
  s.sawUser = true;
  s.stopped = false;
}

/** Normalize the two harness plan tools into one shape. Some models
 *  stringify the array — parse that too rather than dropping the list. */
export function todosFrom(name: string, input: unknown): TodoItem[] | null {
  const obj = input as { todos?: unknown; plan?: unknown } | null;
  let raw = name === "TodoWrite" ? obj?.todos : name === "update_plan" ? obj?.plan : null;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(raw)) return null;
  return raw.flatMap((t) => {
    const item = t as { content?: string; step?: string; activeForm?: string; status?: string };
    const content = item.content ?? item.step ?? item.activeForm;
    if (!content) return [];
    const status: TodoStatus =
      item.status === "in_progress" || item.status === "completed" ? item.status : "pending";
    return [{ content, status }];
  });
}

/** Fold a tool call into the todo model; returns true when the list moved. */
export function applyTodoCall(
  s: ThreadState,
  e: Extract<AgentEvent, { type: "tool-call" }>,
): boolean {
  if (e.partial) return false;
  const todos = todosFrom(e.name, e.input);
  if (todos) {
    s.todos = todos;
    const active = todos.findIndex((t) => t.status === "in_progress");
    if (active !== -1) s.activeTodo = active;
    return true;
  }
  if (s.taskSeen[e.callId]) return false;
  if (e.name === "TaskCreate") {
    const input = e.input as { subject?: string } | null;
    if (!input?.subject) return false;
    s.taskSeen = { ...s.taskSeen, [e.callId]: true };
    s.todos = [...s.todos, { content: input.subject, status: "pending" }];
    s.taskByCall = { ...s.taskByCall, [e.callId]: s.todos.length - 1 };
    return true;
  }
  if (e.name === "TaskUpdate") {
    const i = e.input as { taskId?: unknown; status?: string } | null;
    const idx = s.taskIds[String(i?.taskId)];
    const status = i?.status;
    if (
      idx === undefined ||
      idx >= s.todos.length ||
      (status !== "pending" && status !== "in_progress" && status !== "completed")
    ) {
      return false;
    }
    s.taskSeen = { ...s.taskSeen, [e.callId]: true };
    s.todos = s.todos.map((t, n) => (n === idx ? { ...t, status } : t));
    if (status === "in_progress") s.activeTodo = idx;
    return true;
  }
  return false;
}

/** A TaskCreate result names the task's id ("Task #3 created …"). */
export function applyTaskResult(
  s: ThreadState,
  e: Extract<AgentEvent, { type: "tool-result" }>,
): boolean {
  const created = s.taskByCall[e.callId];
  if (created === undefined) return false;
  const { [e.callId]: _drop, ...rest } = s.taskByCall;
  s.taskByCall = rest;
  const m = /#(\d+)/.exec(e.output);
  if (m) s.taskIds = { ...s.taskIds, [m[1]]: created };
  return true;
}

/** One mark per (round, task); a later snapshot in the same task wins. */
export function markUsage(s: ThreadState, input?: number, output?: number): void {
  if (input === undefined && output === undefined) return;
  const mark: UsageMark = { round: s.round, todo: s.activeTodo, input, output };
  const last = s.usage[s.usage.length - 1];
  if (last && last.todo === s.activeTodo && last.round === s.round) {
    s.usage = [...s.usage.slice(0, -1), mark];
  } else {
    s.usage = [...s.usage, mark];
  }
}

export function tallyOf(todos: TodoItem[]): { done: number; total: number } {
  return { done: todos.filter((t) => t.status === "completed").length, total: todos.length };
}
