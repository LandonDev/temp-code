import type { Task } from "../../components/ui/task-list";
import type { Block } from "../../lib/session";
import type { LiveEditState } from "../../lib/tcserver/store";
import type { TodoItem } from "../../lib/tcserver/todos";
import { activeMs, editPath, groupByTodo } from "../../lib/threads/rounds";

/**
 * The implementation board's folds, pure: the thread's blocks cut into
 * passes (one per request that opened a turn), each pass's tasks as the
 * TaskList reads them, the files each task changed, what needs the
 * person, the last failure, and the record a finished pass keeps.
 */

/** One request round: its todo list, its blocks, its work items, and the
 *  user message that opened it. */
export type RoundData = {
  todos: TodoItem[];
  blocks: Block[];
  work: Block[];
  header: Block | null;
};

export const isError = (b: Block): boolean => b.role === "system" && b.id.startsWith("err:");
export const needsUser = (b: Block): boolean =>
  (!!b.approval && !b.approval.decided) || (!!b.question && b.question.answers === undefined);
/** Bookkeeping-only edits (.temp-code/) aren't work to review. */
export const workEdit = (b: Block): boolean => {
  const p = editPath(b);
  return !!p && !p.includes(".temp-code/");
};
export const firstLine = (b: Block | null | undefined): string => b?.text.split("\n")[0] ?? "";

function findLast<T>(list: readonly T[], test: (v: T) => boolean): T | undefined {
  for (let i = list.length - 1; i >= 0; i--) if (test(list[i])) return list[i];
  return undefined;
}

/** Each user request that opened a new turn is its own pass: its todo
 *  list, its work, its timers. Nothing bleeds across the idle gap. */
export function foldRounds(blocks: Block[], todos: TodoItem[], pastTodos: TodoItem[][]): RoundData[] {
  const cur = pastTodos.length;
  const list: RoundData[] = Array.from({ length: cur + 1 }, (_, r) => ({
    todos: r < cur ? pastTodos[r] : todos,
    blocks: [],
    work: [],
    header: null,
  }));
  for (const b of blocks) {
    const R = list[Math.min(b.round ?? 0, cur)];
    R.blocks.push(b);
    if (R.header === null && b.role === "user") R.header = b;
    if (workEdit(b) || needsUser(b) || isError(b)) R.work.push(b);
  }
  return list;
}

/** A pass with nothing on the board (pure Q&A) earns no row and no number. */
export const isHiddenPass = (r: RoundData): boolean => r.todos.length === 0 && r.work.length === 0;

/** Passes number by what the board shows: a hidden pass consumes none. */
export function passNumbers(rounds: RoundData[]): number[] {
  let n = 0;
  return rounds.map((r) => (isHiddenPass(r) ? 0 : ++n));
}

/** Where a running task's live time counts from: the end of its last
 *  timed block, the running maximum `activeMs` keeps, so
 *  `activeMs(list) + (now − liveFrom(list))` is `activeMs(list, now)`. */
export function liveFrom(list: Block[]): number | undefined {
  let from: number | undefined;
  for (const b of list) {
    if (b.ts === undefined) continue;
    const end = b.role === "tool" ? (b.doneTs ?? b.ts) : b.ts;
    from = Math.max(from ?? end, end);
  }
  return from;
}

/** The pass's todos as the TaskList reads them: an in-progress task is
 *  active only while the thread runs, else it waits. A started task
 *  carries the time its blocks worked; the running one also where its
 *  live time counts from. */
export function tasksOf(todos: TodoItem[], round: number, running: boolean, blocks: Block[] = []): Task[] {
  const byTodo = groupByTodo(blocks, todos.length);
  return todos.map((t, i) => {
    const state = t.status === "completed" ? "done" : t.status === "in_progress" && running ? "active" : "pending";
    const task: Task = { id: `${round}:${i}`, label: t.content, state };
    if (t.status === "pending") return task;
    const list = byTodo.get(i) ?? [];
    const from = state === "active" ? liveFrom(list) : undefined;
    task.time = from === undefined ? { ms: activeMs(list) } : { ms: activeMs(list), from };
    return task;
  });
}

export type ChangeRow = {
  path: string;
  name: string;
  adds: number;
  dels: number;
  /** The harness's edits of this file, oldest first; empty for a shell edit. */
  edits: Block[];
  /** A change the shell made, which no harness edit describes. */
  disk?: LiveEditState;
  /** Still being written. */
  editing: boolean;
};

/** The files one task changed; `task` is null for a pass with no tasks,
 *  "Setup" for work before the first task. */
export type ChangeGroup = { key: string; task: string | null; files: ChangeRow[] };

const nameOf = (path: string): string => path.split("/").pop() ?? path;

/** Shell-made changes file under the task that was running when the edit
 *  began: the last task started before it, kept only if the edit falls
 *  inside that task's span (the live tail stays open-ended). */
function shellByTask(
  blocks: Block[],
  diskOnly: LiveEditState[],
  openTail: boolean,
): Map<number, LiveEditState[]> {
  const spans = new Map<number, { first: number; last: number }>();
  for (const b of blocks) {
    if (b.ts === undefined || b.todo === undefined || b.todo < 0) continue;
    const s = spans.get(b.todo);
    if (!s) spans.set(b.todo, { first: b.ts, last: b.ts });
    else s.last = b.ts;
  }
  const entries = [...spans.entries()].sort((a, b) => a[1].first - b[1].first);
  const out = new Map<number, LiveEditState[]>();
  if (entries.length === 0) return out;
  const tail = entries[entries.length - 1][0];
  for (const e of diskOnly) {
    let owner: number | null = null;
    for (const [i, s] of entries) if (e.startedTs >= s.first - 1500) owner = i;
    if (owner === null) continue;
    if ((openTail && owner === tail) || e.startedTs <= spans.get(owner)!.last + 3000) {
      out.set(owner, [...(out.get(owner) ?? []), e]);
    }
  }
  return out;
}

function filesOf(edits: Block[], shell: LiveEditState[], live: boolean): ChangeRow[] {
  const files = new Map<string, ChangeRow>();
  for (const b of edits) {
    const path = editPath(b);
    if (!path) continue;
    const row = files.get(path) ?? { path, name: nameOf(path), adds: 0, dels: 0, edits: [], editing: false };
    row.adds += b.tool?.preview?.additions ?? 0;
    row.dels += b.tool?.preview?.deletions ?? 0;
    row.edits.push(b);
    row.editing = live && b.doneTs === undefined;
    files.set(path, row);
  }
  for (const e of shell) {
    if (files.has(e.path)) continue;
    files.set(e.path, {
      path: e.path,
      name: nameOf(e.path),
      adds: e.adds ?? 0,
      dels: e.dels ?? 0,
      edits: [],
      disk: e,
      editing: e.state === "editing",
    });
  }
  return [...files.values()];
}

/** Per task, the files it changed: the harness's edits summed by file,
 *  then the shell's under the task that ran when they began. */
export function changesByTask(
  round: RoundData,
  diskOnly: LiveEditState[],
  isCurrent: boolean,
  running: boolean,
): ChangeGroup[] {
  const live = isCurrent && running;
  const edits = round.work.filter(workEdit);
  if (round.todos.length === 0) {
    const files = filesOf(edits, [], live);
    return files.length ? [{ key: "all", task: null, files }] : [];
  }
  const byTodo = groupByTodo(edits, round.todos.length);
  const shell = shellByTask(round.blocks, diskOnly, live);
  const groups: ChangeGroup[] = [];
  const setup = filesOf(byTodo.get(-1) ?? [], [], live);
  if (setup.length) groups.push({ key: "setup", task: "Setup", files: setup });
  round.todos.forEach((t, i) => {
    const files = filesOf(byTodo.get(i) ?? [], shell.get(i) ?? [], live);
    if (files.length) groups.push({ key: `task:${i}`, task: t.content, files });
  });
  return groups;
}

/** Approvals and questions still waiting on the person. */
export const needsYou = (work: Block[]): Block[] => work.filter(needsUser);

/** The pass's last error row, if any. */
export const lastFailure = (work: Block[]): Block | undefined => findLast(work, isError);

/** What a finished pass keeps: when it ended, how long it worked, what
 *  ran it and what it cost. */
export type PassRecord = {
  endedAt?: number;
  workedMs?: number;
  model?: string;
  effort?: string;
  context?: "1M" | "200k";
  speed?: "Fast" | "Ultrafast";
  cost?: number;
};

/** The pass's cost: the session's cost at its end less the last known before it. */
export function passCost(costs: (number | undefined)[], round: number): number | undefined {
  const end = costs[round];
  if (end === undefined) return undefined;
  const prev = findLast(costs.slice(0, round), (c) => c !== undefined);
  return end - (prev ?? 0);
}

export function passRecord(round: RoundData, cost?: number): PassRecord {
  const rec: PassRecord = {};
  const endedAt = findLast(round.blocks, (b) => b.ts !== undefined)?.ts;
  if (endedAt !== undefined) rec.endedAt = endedAt;
  const worked = activeMs(round.blocks);
  if (worked > 1000) rec.workedMs = worked;
  const turn = round.header?.role === "user" ? round.header.turn : undefined;
  if (turn?.model) {
    rec.model = turn.model;
    if (turn.reasoning) rec.effort = turn.reasoning[0].toUpperCase() + turn.reasoning.slice(1);
    rec.context = turn.context1m ? "1M" : "200k";
    if (turn.ultrafast) rec.speed = "Ultrafast";
    else if (turn.fast) rec.speed = "Fast";
  }
  if (cost !== undefined && cost > 0.005) rec.cost = cost;
  return rec;
}
