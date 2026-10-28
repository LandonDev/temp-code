import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown } from "@renderer/chrome/icons";
import { TruncateTip } from "@renderer/components/tip";
import { cn } from "@renderer/lib/cn";
import { duration, useNow } from "@renderer/lib/duration";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./collapsible";

/**
 * A task list an agent works through: a header with a donut of done over
 * total (or, folded, the active task's label), rows whose mark draws a
 * check as they finish, and a cursor that slides to the active row. Each
 * task is one line cut at the column's edge, its whole text on hover; the
 * active task alone shows its whole label. A started task's time ends its
 * row, the active one's ticking.
 */
export type TaskState = "pending" | "active" | "done";
/** `time` is how long a started task worked; with `from`, it is still
 *  running and its live time is `ms + (now − from)`. */
export type TaskTime = { ms: number; from?: number };
export type Task = { id: string; label: string; state: TaskState; progress?: number; time?: TaskTime };

const CHECK = "M4.8 8.4 7.04 10.8 11.52 6.0";
const ARROW = "M5.5 8h5M8.6 6.1 10.5 8 8.6 9.9";

const MARK_LABEL: Record<TaskState, string> = { pending: "Not started", active: "In progress", done: "Done" };

const RING_R = 8 - 1.25 / 2;
const RING_W = 1.25;
const CHECK_W = 1.75;

const MARK_TONE: Record<TaskState, string> = { pending: "text-muted-foreground/60", active: "text-foreground", done: "text-(--task-done)" };

const DONUT_W = 1.75;
const DONUT_R = 8 - DONUT_W / 2;
const DONUT_C = 2 * Math.PI * DONUT_R;

const DONE_LINE = "All tasks complete";

/** A task's time shows once it says something: under this it is noise. */
const TIME_SHOWN_FROM_MS = 1500;

/** The row's time, its own leaf so only it re-renders on the clock. A
 *  parked pane's clock reads 0, and the time holds its counted part. */
function TaskTimeText({ time }: { time: TaskTime }) {
  const now = useNow(time.from !== undefined);
  const ms = time.from !== undefined && now > 0 ? time.ms + Math.max(0, now - time.from) : time.ms;
  if (ms < TIME_SHOWN_FROM_MS) return null;
  return <span className="ms-auto shrink-0 text-xs leading-5 tabular-nums text-muted-foreground">{duration(ms)}</span>;
}

function TaskDonut({ done, total }: { done: number; total: number }) {
  const filled = total > 0 ? done / total : 0;
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className="size-3.5">
      <circle cx="8" cy="8" r={DONUT_R} strokeWidth={DONUT_W} className="stroke-muted-foreground/45" />
      <circle className="task-donut stroke-foreground" cx="8" cy="8" r={DONUT_R} strokeWidth={DONUT_W} strokeLinecap={filled > 0 ? "round" : "butt"} strokeDasharray={DONUT_C} strokeDashoffset={DONUT_C * (1 - filled)} transform="rotate(-90 8 8)" />
    </svg>
  );
}

function TaskMark({ state, className }: { state: TaskState; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round" role="img" aria-label={MARK_LABEL[state]} data-state={state} className={cn("task-mark size-3.5 shrink-0", MARK_TONE[state], className)}>
      <circle className="task-ring-open" cx="8" cy="8" r={RING_R} strokeDasharray="1.2 2" />
      <circle className="task-ring" cx="8" cy="8" r={RING_R} />
      <circle className="task-fill" cx="8" cy="8" r={RING_R + RING_W / 2} fill="currentColor" stroke="none" />
      <path className="task-check" d={CHECK} strokeWidth={CHECK_W} />
    </svg>
  );
}

type Spot = { x: number; y: number; slide: boolean; gone: boolean };

function TaskCursor({ at }: { at: Spot }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round" aria-hidden data-slide={at.slide || undefined} data-gone={at.gone || undefined} style={{ translate: `${at.x}px ${at.y}px` }} className="task-cursor absolute left-0 top-0 size-3.5 text-foreground">
      <path d={ARROW} />
    </svg>
  );
}

const shareText = (value: number) => `${String(Math.round(Math.min(1, Math.max(0, value)) * 100))}%`;

export function TaskList({ tasks, title = "Tasks", defaultOpen = true, className }: { tasks: readonly Task[]; title?: string; defaultOpen?: boolean; className?: string }) {
  const [open, setOpen] = useState(defaultOpen);

  const done = tasks.filter((task) => task.state === "done").length;
  const activeAt = tasks.findIndex((task) => task.state === "active");
  const active = activeAt === -1 ? undefined : tasks[activeAt];
  const complete = tasks.length > 0 && done === tasks.length;
  const headline = open ? title : complete ? DONE_LINE : (active?.label ?? title);

  const rows = useRef<HTMLUListElement>(null);
  const [cursor, setCursor] = useState<Spot | null>(null);
  const activeShare = tasks[activeAt]?.progress;

  useLayoutEffect(() => {
    const list = rows.current;
    const mark = list?.children[activeAt]?.firstElementChild;
    if (!list || !mark) {
      setCursor((was) => (was === null ? null : { ...was, gone: true }));
      return;
    }
    const measure = () => {
      const box = list.getBoundingClientRect();
      const at = mark.getBoundingClientRect();
      return { x: at.left - box.left - list.clientLeft, y: at.top - box.top - list.clientTop };
    };
    setCursor((was) => ({ ...measure(), slide: was !== null && !was.gone, gone: false }));
    const watch = new ResizeObserver(() =>
      setCursor((was) => {
        if (was === null) return null;
        const to = measure();
        return was.x === to.x && was.y === to.y ? was : { ...was, ...to };
      }),
    );
    watch.observe(list);
    return () => watch.disconnect();
  }, [activeAt, open, tasks.length]);

  useEffect(() => {
    if (complete) setOpen(false);
  }, [complete]);

  return (
    <Collapsible data-slot="task-list" open={open} onOpenChange={setOpen} className={cn("w-full rounded-xl border border-border bg-card text-card-foreground", className)}>
      <CollapsibleTrigger className="group/task-header flex w-full items-start gap-2.5 rounded-xl px-3 py-2.5 text-start outline-none transition-[background-color] duration-(--dur-fast) focus-visible:ring-2 focus-visible:ring-ring">
        <span className="relative mt-[3px] block size-3.5 shrink-0">
          {complete ? <TaskMark state="done" /> : <TaskDonut done={done} total={tasks.length} />}
        </span>
        <TruncateTip text={headline}>
          <span className="block min-w-0 flex-1 truncate text-[13px] font-medium leading-5 text-foreground">{headline}</span>
        </TruncateTip>
        <span className={cn("flex shrink-0 items-center gap-1 text-[13px] leading-5 tabular-nums transition-colors", complete ? "text-foreground" : "text-muted-foreground")}>
          <span dir="ltr">
            {done}/{tasks.length}
          </span>
          <ChevronDown aria-hidden data-open={open || undefined} className="task-chevron size-3.5" />
        </span>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <ul ref={rows} className={cn("relative -mt-1 px-3 pb-2", activeShare !== undefined && "pe-14")}>
          {tasks.map((task) => (
            <li key={task.id} className="flex min-h-7 items-start gap-2.5 py-1">
              <TaskMark state={task.state} className="mt-[3px]" />
              {/* One element in every state, so the strike draws when the active row finishes. */}
              <TruncateTip text={task.label}>
                <span data-state={task.state} className={cn("task-label relative min-w-0 text-[13px] leading-5", task.state === "active" ? "break-words text-foreground" : task.state === "done" ? "truncate text-(--task-done)" : "truncate text-muted-foreground")}>
                  {task.label}
                  <span aria-hidden className="task-strike" />
                </span>
              </TruncateTip>
              {task.time ? <TaskTimeText time={task.time} /> : null}
              {task.state === "active" && task.progress !== undefined ? <span className="sr-only">{shareText(task.progress)} complete</span> : null}
            </li>
          ))}
          {cursor === null ? null : <TaskCursor at={cursor} />}
          {cursor === null || activeShare === undefined ? null : (
            <span aria-hidden data-slide={cursor.slide || undefined} data-gone={cursor.gone || undefined} style={{ translate: `0 ${cursor.y - 3}px` }} className="task-share absolute end-3 top-0 rounded-full bg-muted px-1.5 text-xs leading-5 text-muted-foreground tabular-nums">
              {shareText(activeShare)}
            </span>
          )}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}
