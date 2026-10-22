import { parseNotes } from "@shared/notes";
import type { Block, Session } from "../../../lib/session";
import type { TodoItem } from "../../../lib/tcserver/todos";
import type { SessionMeta } from "../../../lib/tcserver/types";
import { lastAssistantLine, type AgentTone } from "../../../lib/threads/agents";
import { clockTime, groupOf } from "./useMasterModel";

/**
 * What a row shows under its two lines, by the thread's type: an
 * implementation its task list from the fold's board state, a research or
 * orchestration thread one summary line (the notes' State, else the
 * thread's latest words). Chat and plan rows carry nothing more. Pure, so
 * the dom tests read the same rules the row draws.
 */

export type RowBody = { kind: "tasks"; tasks: TodoItem[] } | { kind: "summary"; text: string } | null;

/** The current round's tasks, or none before the first list. */
export function taskList(session: Pick<Session, "thread"> | undefined): TodoItem[] {
  return session?.thread?.todos ?? [];
}

/** The first line under `## State` in the thread's notes, else its
 *  latest assistant line; empty when it has said nothing yet. */
export function summaryLine(notesText: string | undefined, blocks: readonly Block[]): string {
  if (notesText) {
    const state = parseNotes(notesText).sections.find((s) => s.heading === "State");
    const line = state?.body.split("\n").find((l) => l.trim());
    if (line) return line.replace(/^[-*]\s+/, "").trim();
  }
  return lastAssistantLine(blocks as Block[]);
}

export function rowBody(
  meta: Pick<SessionMeta, "threadType">,
  session: Pick<Session, "thread" | "blocks"> | undefined,
  notesText: string | undefined,
  /** The row's second line, so a summary never repeats it. */
  whatText = "",
): RowBody {
  switch (meta.threadType) {
    case "implementation": {
      const tasks = taskList(session);
      return tasks.length > 0 ? { kind: "tasks", tasks } : null;
    }
    case "research":
    case "orchestration": {
      const text = summaryLine(notesText, session?.blocks ?? []);
      return text && text !== whatText ? { kind: "summary", text } : null;
    }
    default:
      return null;
  }
}

/** Whether a row's task list is open before the person touches it: open
 *  while the thread works or needs them, folded once it sits in Done (done,
 *  idle after a turn, stopped); the tally stays either way. */
export function tasksOpenByDefault(status: SessionMeta["status"]): boolean {
  return groupOf(status) !== "done";
}

/** Done of total once the thread has a task list; null before. The row
 *  prints it as "3/7" with a thin bar filled to done/total. */
export function taskProgress(tasks: readonly TodoItem[]): { done: number; total: number } | null {
  if (tasks.length === 0) return null;
  return { done: tasks.filter((t) => t.status === "completed").length, total: tasks.length };
}

/** "3/7" once the thread has a task list; null before. */
export function taskTally(tasks: readonly TodoItem[]): string | null {
  const p = taskProgress(tasks);
  return p ? `${p.done}/${p.total}` : null;
}

/** The row's second line: the scheduler's or the harness's `activity`
 *  while the thread is queued or working, the question or the failure
 *  while it needs the person, when it landed once it is done. */
export function whatLine(
  meta: Pick<SessionMeta, "status" | "activity" | "updatedAt">,
  line: { text: string; tone: AgentTone },
  landed: boolean,
): { text: string; tone: AgentTone } | null {
  switch (meta.status) {
    case "waiting":
    case "error":
      return line.text ? line : null;
    case "paused":
      return { text: "Paused", tone: "muted" };
    case "queued":
    case "starting":
    case "running":
    case "watching":
      return { text: meta.activity?.trim() || line.text, tone: "muted" };
    case "stopped":
      return { text: "Stopped", tone: "muted" };
    default:
      return landed ? { text: `Landed ${clockTime(meta.updatedAt)}`, tone: "muted" } : null;
  }
}
