import type { BoardDigest } from "@server/shared/contract-batch";
import { threadStateOf, type ThreadState } from "../../../components/ui/status";
import type { TodoItem } from "../../../lib/tcserver/todos";
import type { SessionMeta } from "../../../lib/tcserver/types";
import { leadStripped } from "../../../lib/threads/agents";
import { clockTime } from "./useMasterModel";

/**
 * What a board row says under its title (docs/LAYOUT.md "Master"): the
 * thread's state in the vocabulary (components/ui/status.tsx) and what
 * that state is about, from its meta and its digest (the host's
 * `batch.board`, boardDigest.ts). The section heading says the state's
 * word, so the row says only the detail. Pure, so the dom tests read the
 * same rules the row draws.
 */

export type RowStatus = { state: ThreadState; detail: string };

const NO_TASKS: TodoItem[] = [];

/** The current task list from the digest, or none before the first. */
export function taskList(digest: Pick<BoardDigest, "todos">): TodoItem[] {
  return digest.todos ?? NO_TASKS;
}

/** The notes' State line, else the last words; empty when it has said nothing yet. */
export function summaryLine(digest: Pick<BoardDigest, "state" | "last">): string {
  return digest.state || digest.last || "";
}

/** The task in hand: the one in progress; null when none is. */
export function taskInHand(todos: readonly TodoItem[]): string | null {
  return todos.find((t) => t.status === "in_progress")?.content.trim() || null;
}

/** "3/7" once the thread has a task list; null before. */
export function taskTally(tasks: readonly TodoItem[]): string | null {
  if (tasks.length === 0) return null;
  return `${tasks.filter((t) => t.status === "completed").length}/${tasks.length}`;
}

/** A row's state and its detail. An idle thread on the board has had a
 *  turn, so it is done. The detail: the task in hand or the activity while working, the question or the
 *  approval while waiting, the failure, what it watches or waits for in
 *  the queue (without the lead the word already says), when it landed,
 *  else a research or orchestration thread's summary once done. */
export function rowStatus(
  meta: Pick<SessionMeta, "status" | "activity" | "failure" | "updatedAt" | "threadType">,
  digest: Pick<BoardDigest, "todos" | "state" | "last" | "question" | "failure">,
  landed: boolean,
): RowStatus {
  const state = threadStateOf(meta.status, { settled: meta.status === "idle" });
  const activity = meta.activity?.trim() ?? "";
  switch (state) {
    case "working":
      return { state, detail: (meta.threadType === "implementation" && taskInHand(taskList(digest))) || activity };
    case "waiting":
      return { state, detail: digest.question?.trim() || (activity ? `approve ${activity}` : "") };
    case "failed":
      return { state, detail: digest.failure?.trim() || meta.failure?.summary.trim() || "" };
    case "watching":
    case "queued":
      return { state, detail: leadStripped(activity, state) };
    case "done":
      if (landed) return { state, detail: `Landed ${clockTime(meta.updatedAt)}` };
      return { state, detail: meta.threadType === "research" || meta.threadType === "orchestration" ? summaryLine(digest) : "" };
    default:
      return { state, detail: "" };
  }
}

/** The New pass dialog's one line under the title: the board row's own
 *  status, else the thread's last words. */
export function passLine(
  meta: Pick<SessionMeta, "status" | "activity" | "failure" | "updatedAt" | "threadType">,
  digest: BoardDigest,
  landed: boolean,
): RowStatus {
  const status = rowStatus(meta, digest, landed);
  return status.detail ? status : { state: status.state, detail: digest.last ?? "" };
}
