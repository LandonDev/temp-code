import { useReducedMotion } from "motion/react";
import { memo, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronRight, Circle, MessageSquare, Pause, Play, Square, X } from "../../../chrome/icons";
import { HarnessIcon } from "../../../chrome/HarnessIcon";
import { ArchiveThreadDialog } from "../../../chrome/ThreadResourcesDialog";
import * as commands from "../../../lib/tcserver/commands";
import { asHarness, useSessionMeta } from "../../../lib/tcserver/store";
import type { TodoItem } from "../../../lib/tcserver/todos";
import type { SessionMeta } from "../../../lib/tcserver/types";
import { hasRunningTurn } from "../../../lib/threadBatch";
import { loadThreadResources, useThreadResources } from "../../../lib/threadResources";
import { modelLabel, TONE_CLASS } from "../../../lib/threads/agents";
import { TweenHeight } from "../../../motion";
import { MatrixSpinner, THREAD_GLYPHS, THREAD_TINTS } from "../bits";
import { StatusGlyph } from "../fleet/rowBits";
import { rowBody, taskList, taskProgress, tasksOpenByDefault, whatLine } from "./rowBody";
import { digestLine, typeWord, useBoardDigest, useRowMeta, type BoardRowRef, type RowHost } from "./useMasterModel";

/**
 * One row of the batch (docs/LAYOUT.md "Master"). Two lines: the type's
 * glyph, the title and the task tally; then the status glyph beside what
 * the thread is doing, and at the right the host's dot and name when the
 * thread runs on another host than the master, the provider's mark, the
 * model, its effort and context. Under an implementation its task list,
 * open while it works and folded once it is done, the tally its
 * disclosure; under a research or orchestration thread one summary line.
 * A row of a host out of reach is under the offline tint. A click opens
 * the thread's full view in the board's place; hover shows Message, Pause
 * or Resume, Stop and Remove. Every action goes to the row's own host (the
 * commands route by the thread's id). Nothing on the row is separated by
 * a dot.
 *
 * The row reads its own meta, its plan's and its digest (the host's
 * `batch.board`), and takes nothing else that changes: one child's
 * activity re-renders this row alone, and nothing here loads a
 * transcript, polls a context or reads notes.
 */

export const MasterRow = memo(function MasterRow({
  rowRef,
  landed,
  host,
  onOpen,
}: {
  rowRef: BoardRowRef;
  /** The batch marked this row's branch landed. */
  landed: boolean;
  /** The thread's host when it is not the master's; null otherwise. */
  host: RowHost | null;
  /** Open the thread's full view; `focus` lands in its composer. */
  onOpen: (id: string, focus?: boolean) => void;
}) {
  const meta = useRowMeta(rowRef);
  const plan = useSessionMeta(rowRef.planId);
  const digest = useBoardDigest(rowRef.id);
  if (!meta) return null;
  return <RowBodyView meta={meta} plan={plan} digest={digest} landed={landed} host={host} onOpen={onOpen} />;
});

function RowBodyView({
  meta,
  plan,
  digest,
  landed,
  host,
  onOpen,
}: {
  meta: SessionMeta;
  plan: SessionMeta | null;
  digest: ReturnType<typeof useBoardDigest>;
  landed: boolean;
  host: RowHost | null;
  onOpen: (id: string, focus?: boolean) => void;
}) {
  const title = plan?.title || meta.title;
  const what = whatLine(meta, digestLine(meta, digest), landed);
  const body = rowBody(meta, digest, what?.text);
  const progress = taskProgress(taskList(digest));
  // The person's own open or close holds while the row is on screen; until
  // then the list follows the thread (open while it works, folded once done).
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const tasksOpen = expanded ?? tasksOpenByDefault(meta.status);
  const foldable = body?.kind === "tasks";
  const reduce = useReducedMotion();
  const queued = meta.status === "queued";
  const settled = !queued && !what && !landed && meta.status !== "waiting" && meta.status !== "error";
  const dim = queued || meta.status === "idle" || meta.status === "stopped" || meta.status === "done";
  const [archiving, setArchiving] = useState(false);
  const resources = useThreadResources(archiving ? meta.id : null);
  const Glyph = meta.threadType ? THREAD_GLYPHS[meta.threadType] : null;
  const tint = meta.threadType ? THREAD_TINTS[meta.threadType] : "text-content/50";

  const openArchive = () => {
    void loadThreadResources(meta.id);
    setArchiving(true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen(meta.id);
    }
  };

  const actions: ReactNode[] = [];
  if (queued) {
    // Start now goes past `after`; Remove from queue is the fleet switches'
    // Stop on a queued root (it archives; lib/threadBatch.ts).
    actions.push(<Action key="start" title="Start now" icon={Play} onClick={() => void commands.startNow(meta.id)} />);
    actions.push(
      <Action key="remove" title="Remove from queue" icon={X} onClick={() => void commands.sessionBatch(meta.environmentId, "stop", [meta.id])} />,
    );
  } else {
    actions.push(<Action key="message" title="Message" icon={MessageSquare} onClick={() => onOpen(meta.id, true)} />);
    if (hasRunningTurn(meta)) {
      actions.push(<Action key="pause" title="Pause" icon={Pause} onClick={() => void commands.pause(meta.id)} />);
      actions.push(<Action key="stop" title="Stop" icon={Square} onClick={() => void commands.interrupt(meta.id)} />);
    } else if (meta.status === "paused" || meta.status === "stopped") {
      actions.push(<Action key="resume" title="Resume" icon={Play} onClick={() => void commands.resume(meta.id)} />);
    }
    actions.push(<Action key="remove" title="Remove" icon={X} onClick={openArchive} />);
  }

  return (
    <div
      className={`group relative rounded-lg transition-colors duration-100 hover:bg-content/5 ${host?.offline ? "opacity-50" : ""}`}
      data-status={meta.status}
      data-type={meta.threadType ?? undefined}
      data-plan={plan?.id}
      data-host={host?.id}
      data-host-offline={host?.offline || undefined}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => onOpen(meta.id)}
        onKeyDown={onKey}
        data-tasks-open={foldable ? tasksOpen : undefined}
        className="grid w-full cursor-default grid-cols-[16px_1fr] gap-x-2 rounded-lg px-3 py-2 text-left"
      >
        {/* Line one: the type's glyph, the title, the tally. */}
        <span className="flex h-[18px] items-center justify-center">
          {Glyph ? <Glyph className={`size-3.5 ${dim ? "text-content/40" : tint}`} strokeWidth={1.75} /> : null}
        </span>
        <span className="flex min-w-0 items-baseline gap-2 leading-[18px]">
          <span className={`min-w-0 truncate text-[13px] font-medium ${dim ? "text-content/60" : "text-content"}`}>{title || "Untitled"}</span>
          <span className="shrink-0 text-xs text-content/40">{typeWord(meta)}</span>
          {progress ? (
            <Tally
              progress={progress}
              fold={foldable ? { open: tasksOpen, onToggle: () => setExpanded(!tasksOpen) } : null}
            />
          ) : null}
        </span>

        {/* Line two: the status glyph beside the activity; the model at the right. */}
        <span className="flex h-4 items-center justify-center">
          <StatusGlyph status={settled ? "idle" : meta.status} />
        </span>
        <span className="flex min-w-0 items-center gap-3 leading-4">
          <span className={`min-w-0 flex-1 truncate text-xs ${what ? TONE_CLASS[what.tone] : "text-content/40"}`}>
            {what?.text ?? (settled ? "Done" : "")}
          </span>
          <ModelMark meta={meta} host={host} />
        </span>

        {body?.kind === "tasks" ? (
          <>
            <span />
            <TweenHeight open={tasksOpen} animate={!reduce}>
              <TaskList tasks={body.tasks} dim={dim} open={tasksOpen} />
            </TweenHeight>
          </>
        ) : body?.kind === "summary" ? (
          <>
            <span />
            <span className="mt-1 line-clamp-2 text-xs leading-4 text-content/50" data-summary>
              {body.text}
            </span>
          </>
        ) : null}
      </div>

      <div
        data-actions
        className="pointer-events-none absolute top-[13px] right-2 flex gap-0.5 rounded-md border border-content/10 bg-background-base p-0.5 opacity-0 transition-opacity duration-100 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
      >
        {actions}
      </div>

      {archiving ? (
        <ArchiveThreadDialog
          sessionId={meta.id}
          title={title || "this thread"}
          resources={resources}
          onCancel={() => setArchiving(false)}
          onArchived={() => setArchiving(false)}
        />
      ) : null}
    </div>
  );
}

/** The task tally right after the type word: "3/7" and a thin bar filled
 *  to done of total, the foot's own meter (BatchFoot) at row scale. With a
 *  task list under the row it is the list's disclosure too, a chevron at
 *  its end turning when open; its click never reaches the row. */
function Tally({ progress, fold }: { progress: { done: number; total: number }; fold: { open: boolean; onToggle: () => void } | null }) {
  const { done, total } = progress;
  const meter = (
    <>
      <span>
        {done}/{total}
      </span>
      <span
        className="block h-0.5 w-8 overflow-hidden rounded-full bg-content/10"
        role="progressbar"
        aria-label={`${done} of ${total} tasks done`}
        aria-valuenow={done}
        aria-valuemin={0}
        aria-valuemax={total}
      >
        <span
          className="block h-full rounded-full bg-content/40"
          style={{ transform: `scaleX(${total ? done / total : 0})`, transformOrigin: "left", transition: "transform 200ms linear" }}
        />
      </span>
    </>
  );
  if (!fold) {
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-content/50" data-tally>
        {meter}
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-expanded={fold.open}
      aria-label={`${fold.open ? "Hide" : "Show"} tasks`}
      onClick={(e) => {
        e.stopPropagation();
        fold.onToggle();
      }}
      onKeyDown={(e) => e.stopPropagation()}
      className="pressable -mx-1 flex shrink-0 items-center gap-1.5 rounded px-1 text-xs tabular-nums text-content/50 hover:text-content/80"
      data-tally
    >
      {meter}
      <ChevronRight className={`size-3 transition-transform duration-150 ease-(--ease-out) ${fold.open ? "rotate-90" : ""}`} strokeWidth={1.75} />
    </button>
  );
}

/** The provider's mark, the model, then its effort and context in a
 *  quieter gray; first the host's dot and name, as the thread header's
 *  host chip draws them, when the thread runs elsewhere. */
function ModelMark({ meta, host }: { meta: SessionMeta; host: RowHost | null }) {
  const rest = [meta.reasoning, meta.context1m ? "1M" : null].filter(Boolean).join(" ");
  return (
    <span
      className="flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap transition-opacity duration-100 group-hover:opacity-0 group-focus-within:opacity-0"
      data-model
    >
      {host ? (
        <span className="mr-1 flex items-center gap-1.5 text-content/40" title={host.offline ? `${host.name} is offline` : `On ${host.name}`}>
          <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${host.tone}`} />
          {host.name}
        </span>
      ) : null}
      <HarnessIcon harness={asHarness(meta.provider)} className="size-3 text-content/60" />
      <span className="text-content/60">{modelLabel(meta.provider, meta.model)}</span>
      {rest ? <span className="text-content/35">{rest}</span> : null}
    </span>
  );
}

/** The implementation's tasks as a checklist: a check once done, the
 *  spinner on the one in hand, a hollow ring ahead. Progress reads down
 *  the glyph column. */
export function TaskList({ tasks, dim = false, open = true }: { tasks: readonly TodoItem[]; dim?: boolean; open?: boolean }) {
  return (
    <ul className="flex flex-col gap-[3px] pt-1.5" data-tasks inert={!open} aria-hidden={!open}>
      {tasks.map((task, i) => (
        <li key={i} className="grid grid-cols-[12px_1fr] items-start gap-x-2 text-xs leading-4" data-task-status={task.status}>
          <span className="flex h-4 items-center justify-center">
            {task.status === "completed" ? (
              <Check className="size-3 text-content/35" strokeWidth={2} />
            ) : task.status === "in_progress" && !dim ? (
              <MatrixSpinner cell={1.5} />
            ) : (
              <Circle className="size-[9px] text-content/25" strokeWidth={2} />
            )}
          </span>
          <span
            className={`min-w-0 truncate ${
              task.status === "completed" ? "text-content/40" : task.status === "in_progress" ? "text-content" : "text-content/55"
            }`}
          >
            {task.content}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Action({ title, icon: Icon, onClick }: { title: string; icon: typeof X; onClick: () => void }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="pressable grid h-5 w-[22px] place-items-center rounded text-content/50 hover:bg-content/8 hover:text-content"
    >
      <Icon className="size-3" strokeWidth={1.5} />
    </button>
  );
}
