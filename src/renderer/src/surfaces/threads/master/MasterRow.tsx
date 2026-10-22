import { useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, Circle, MessageSquare, Pause, Play, Square, X } from "../../../chrome/icons";
import { HarnessIcon } from "../../../chrome/HarnessIcon";
import { ArchiveThreadDialog } from "../../../chrome/ThreadResourcesDialog";
import * as commands from "../../../lib/tcserver/commands";
import { asHarness } from "../../../lib/tcserver/store";
import type { TodoItem } from "../../../lib/tcserver/todos";
import type { SessionMeta } from "../../../lib/tcserver/types";
import { hasRunningTurn } from "../../../lib/threadBatch";
import { useThreadNotes } from "../../../lib/threadNotes";
import { loadThreadResources, useThreadResources } from "../../../lib/threadResources";
import { modelLabel, TONE_CLASS } from "../../../lib/threads/agents";
import { MatrixSpinner, THREAD_GLYPHS, THREAD_TINTS } from "../bits";
import { StatusGlyph } from "../fleet/rowBits";
import { useAgentModel } from "../fleet/useFleetModel";
import { rowBody, taskList, taskTally, whatLine } from "./rowBody";
import { typeWord, type MasterRowModel } from "./useMasterModel";

/**
 * One row of the batch (docs/LAYOUT.md "Master"). Two lines: the type's
 * glyph, the title and the task tally; then the status glyph beside what
 * the thread is doing, and at the right the provider's mark, the model,
 * its effort and context. Under an implementation its task list; under a
 * research or orchestration thread one summary line. A click opens the
 * thread in the master view's right pane; hover shows Message, Pause or
 * Resume, Stop and Remove. Nothing on the row is separated by a dot.
 */

export function MasterRow({
  row,
  now,
  fleetSize,
  landed,
  hostName,
  open,
  onOpen,
}: {
  row: MasterRowModel;
  now: number;
  fleetSize: number;
  /** The batch marked this row's branch landed. */
  landed: boolean;
  /** The thread's host when it is not the master's; null otherwise. */
  hostName: string | null;
  /** This row's thread is the one open in the right pane. */
  open: boolean;
  /** Open the thread in the pane; `focus` lands in its composer. */
  onOpen: (id: string, focus?: boolean) => void;
}) {
  const { meta, plan, title } = row;
  const { session, line } = useAgentModel(meta, now, fleetSize);
  const notes = useThreadNotes(
    meta.threadType === "research" || meta.threadType === "orchestration" ? meta.environmentId : null,
    meta.id,
  );
  const what = whatLine(meta, line, landed);
  const body = rowBody(meta, session, notes?.text, what?.text);
  const tally = taskTally(taskList(session));
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
    if (e.key === "Enter") {
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
      className={`group relative rounded-lg transition-colors duration-100 hover:bg-content/5 ${open ? "bg-content/5" : ""}`}
      data-open={open || undefined}
      data-status={meta.status}
      data-type={meta.threadType ?? undefined}
      data-plan={plan?.id}
    >
      <button
        type="button"
        onClick={() => onOpen(meta.id)}
        onKeyDown={onKey}
        aria-current={open || undefined}
        className="grid w-full grid-cols-[16px_1fr] gap-x-2 rounded-lg px-3 py-2 text-left"
      >
        {/* Line one: the type's glyph, the title, the tally. */}
        <span className="flex h-[18px] items-center justify-center">
          {Glyph ? <Glyph className={`size-3.5 ${dim ? "text-content/40" : tint}`} strokeWidth={1.75} /> : null}
        </span>
        <span className="flex min-w-0 items-baseline gap-2 leading-[18px]">
          <span className={`min-w-0 truncate text-[13px] font-medium ${dim ? "text-content/60" : "text-content"}`}>{title || "Untitled"}</span>
          <span className="shrink-0 text-xs text-content/40">{typeWord(meta)}</span>
          <span className="flex-1" />
          {tally ? (
            <span className="shrink-0 text-xs tabular-nums text-content/50 transition-opacity duration-100 group-hover:opacity-0 group-focus-within:opacity-0" data-tally>
              {tally}
            </span>
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
          <ModelMark meta={meta} hostName={hostName} />
        </span>

        {body?.kind === "tasks" ? (
          <>
            <span />
            <TaskList tasks={body.tasks} dim={dim} />
          </>
        ) : body?.kind === "summary" ? (
          <>
            <span />
            <span className="mt-1 line-clamp-2 text-xs leading-4 text-content/50" data-summary>
              {body.text}
            </span>
          </>
        ) : null}
      </button>

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

/** The provider's mark, the model, then its effort and context in a
 *  quieter gray; the host's name first when the thread runs elsewhere. */
function ModelMark({ meta, hostName }: { meta: SessionMeta; hostName: string | null }) {
  const rest = [meta.reasoning, meta.context1m ? "1M" : null].filter(Boolean).join(" ");
  return (
    <span
      className="flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap transition-opacity duration-100 group-hover:opacity-0 group-focus-within:opacity-0"
      data-model
    >
      {hostName ? <span className="text-content/40">{hostName}</span> : null}
      <HarnessIcon harness={asHarness(meta.provider)} className="size-3 text-content/60" />
      <span className="text-content/60">{modelLabel(meta.provider, meta.model)}</span>
      {rest ? <span className="text-content/35">{rest}</span> : null}
    </span>
  );
}

/** The implementation's tasks as a checklist: a check once done, the
 *  spinner on the one in hand, a hollow ring ahead. Progress reads down
 *  the glyph column. */
export function TaskList({ tasks, dim = false }: { tasks: readonly TodoItem[]; dim?: boolean }) {
  return (
    <ul className="mt-1.5 flex flex-col gap-[3px]" data-tasks>
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
