import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { DUR, EASE_OUT } from "../../lib/ease";
import type { ProjectPlanState } from "@server/shared/contract-projectplan";
import { nextMilestone, parseProjectPlan, type Milestone } from "@server/shared/projectPlan";
import { Check, GitFork, MapIcon, Pencil, Pin, PinOff } from "../../chrome/icons";
import {
  pinProjectPlan,
  reviseProjectPlan,
  startMilestoneOrchestration,
  startMilestonePlanning,
  tickMilestone,
} from "../../lib/projectPlan";
import type { Session } from "../../lib/session";
import { MatrixSpinner } from "./bits";

/**
 * The project plan's two live pieces (docs/PROJECT-PLAN.md): the milestone
 * list with its ticks, and the options card a complete plan ends with. The
 * same options sit in the project header's plan chip.
 */

/** The ## Milestones section rendered as rows: a tick (by hand here; the
 *  landed build ticks on its own), the title, and the three fields. */
export function MilestoneList({
  doc,
  projectId,
  onTicked,
}: {
  doc: string;
  projectId: string | null | undefined;
  onTicked?: () => void;
}) {
  const { milestones } = parseProjectPlan(doc);
  const [busy, setBusy] = useState<number | null>(null);
  if (milestones.length === 0) return null;
  const toggle = async (m: Milestone): Promise<void> => {
    if (!projectId || busy !== null) return;
    setBusy(m.index);
    try {
      await tickMilestone(projectId, m.index, !m.done);
      onTicked?.();
    } finally {
      setBusy(null);
    }
  };
  return (
    <ol className="my-2 flex flex-col gap-1" aria-label="Milestones">
      {milestones.map((m) => (
        <li key={m.index} className="flex items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-content/[0.03]">
          <button
            type="button"
            role="checkbox"
            aria-checked={m.done}
            aria-label={`Milestone ${m.index}: ${m.title}${m.done ? ", done" : ""}`}
            disabled={!projectId}
            onClick={() => void toggle(m)}
            className={`pressable mt-[3px] grid size-4 shrink-0 place-items-center rounded-[5px] border transition-colors ${
              m.done ? "border-success bg-success text-background-base" : "border-content/25 text-transparent hover:border-content/50"
            }`}
          >
            {busy === m.index ? <MatrixSpinner cell={1} /> : <Check className="size-3" strokeWidth={2.5} />}
          </button>
          <div className="min-w-0 flex-1">
            <p className={`text-[13px] leading-5 ${m.done ? "text-content/50 line-through decoration-content/30" : "text-content"}`}>
              <span className="tabular-nums text-content/40">{m.index}.</span> {m.title}
            </p>
            {m.scope || m.dependencies || m.doneWhen ? (
              <dl className="mt-0.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-px text-xs leading-[18px] text-content/50">
                {m.scope ? (
                  <>
                    <dt className="text-content/40">Scope</dt>
                    <dd>{m.scope}</dd>
                  </>
                ) : null}
                {m.dependencies ? (
                  <>
                    <dt className="text-content/40">Depends on</dt>
                    <dd>{m.dependencies}</dd>
                  </>
                ) : null}
                {m.doneWhen ? (
                  <>
                    <dt className="text-content/40">Done when</dt>
                    <dd>{m.doneWhen}</dd>
                  </>
                ) : null}
              </dl>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

type Busy = "plan" | "orchestrate" | "revise" | "pin" | null;

const ROW =
  "group/act flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-content/5 active:bg-content/10 disabled:pointer-events-none disabled:opacity-60";
const TILE = "flex size-8 shrink-0 items-center justify-center rounded-lg bg-content/5";

/** What a finished project plan offers. `state` is the server's view (the
 *  pin); `doc` is the file as last polled, for the next milestone. */
export function ProjectPlanOptions({
  session,
  doc,
  state,
  onStarted,
  onChanged,
  compact = false,
}: {
  session: Session;
  doc: string;
  state: ProjectPlanState | null | undefined;
  /** A thread was started: open it. */
  onStarted?: (sessionId: string) => void;
  /** The plan's state changed (pin, revision turn sent). */
  onChanged?: () => void;
  /** In the header popover: no revision field, tighter rows. */
  compact?: boolean;
}) {
  const [busy, setBusy] = useState<Busy>(null);
  const [revising, setRevising] = useState(false);
  const [ask, setAsk] = useState("");
  const next = nextMilestone(doc);
  const pinned = state?.pinned ?? false;
  const projectId = session.projectId ?? null;
  const run = async (what: Exclude<Busy, null>, fn: () => Promise<void>): Promise<void> => {
    if (busy) return;
    setBusy(what);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className={compact ? "p-1" : "p-1"} data-project-plan-options>
      <button
        type="button"
        disabled={!next || busy !== null}
        onClick={() =>
          void run("plan", async () => {
            const t = await startMilestonePlanning(session, next!);
            onStarted?.(t.id);
          })
        }
        className={ROW}
      >
        <span className={TILE}>
          {busy === "plan" ? <MatrixSpinner cell={2} /> : <MapIcon className="size-4 text-violet" strokeWidth={1.75} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium">Plan the next milestone</span>
          <span className="block truncate text-xs text-content/50">
            {next ? `${next.index}. ${next.title}` : "Every milestone is done"}
          </span>
        </span>
      </button>
      <button
        type="button"
        disabled={!next || busy !== null}
        onClick={() =>
          void run("orchestrate", async () => {
            const t = await startMilestoneOrchestration(session, next!);
            onStarted?.(t.id);
          })
        }
        className={ROW}
      >
        <span className={TILE}>
          {busy === "orchestrate" ? <MatrixSpinner cell={2} /> : <GitFork className="size-4 text-warning" strokeWidth={1.75} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium">
            {next ? `Start an orchestration thread for milestone ${next.index}` : "Start an orchestration thread"}
          </span>
          <span className="block text-xs text-content/50">Split the milestone across subagents</span>
        </span>
      </button>
      {compact ? (
        <button
          type="button"
          disabled={busy !== null}
          onClick={() =>
            void run("revise", async () => {
              await reviseProjectPlan(session, "");
              onChanged?.();
            })
          }
          className={ROW}
        >
          <span className={TILE}>
            {busy === "revise" ? <MatrixSpinner cell={2} /> : <Pencil className="size-4 text-content/60" strokeWidth={1.75} />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium">Revise the plan</span>
            <span className="block text-xs text-content/50">A new turn in the plan's thread</span>
          </span>
        </button>
      ) : revising ? (
        <form
          className="flex items-center gap-2 px-2 py-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void run("revise", async () => {
              await reviseProjectPlan(session, ask);
              setAsk("");
              setRevising(false);
              onChanged?.();
            });
          }}
        >
          <Pencil className="size-3.5 shrink-0 text-content/50" strokeWidth={1.75} />
          <input
            autoFocus
            value={ask}
            onChange={(e) => setAsk(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setRevising(false)}
            placeholder="What should change? (empty: re-survey and update)"
            aria-label="What should change"
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-content/40"
          />
          <button
            type="submit"
            disabled={busy !== null}
            className="pressable flex h-7 items-center gap-1.5 rounded-md bg-content px-2.5 text-[12px] font-medium text-background-base hover:bg-content/90 disabled:opacity-40"
          >
            {busy === "revise" ? <MatrixSpinner cell={2} /> : "Send"}
          </button>
        </form>
      ) : (
        <button type="button" disabled={busy !== null} onClick={() => setRevising(true)} className={ROW}>
          <span className={TILE}>
            <Pencil className="size-4 text-content/60" strokeWidth={1.75} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium">Revise the plan</span>
            <span className="block text-xs text-content/50">A new turn in this thread</span>
          </span>
        </button>
      )}
      <button
        type="button"
        disabled={!projectId || busy !== null}
        aria-pressed={pinned}
        onClick={() =>
          void run("pin", async () => {
            await pinProjectPlan(projectId!, !pinned);
            onChanged?.();
          })
        }
        className={ROW}
      >
        <span className={TILE}>
          {busy === "pin" ? (
            <MatrixSpinner cell={2} />
          ) : pinned ? (
            <PinOff className="size-4 text-content/60" strokeWidth={1.75} />
          ) : (
            <Pin className="size-4 text-info" strokeWidth={1.75} />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium">{pinned ? "Stop keeping as the project's plan" : "Keep as the project's plan"}</span>
          <span className="block text-xs text-content/50">
            {pinned ? "The project header shows its milestones" : "Shown in the project header, ticked as builds land"}
          </span>
        </span>
      </button>
    </div>
  );
}

/** The card a complete project plan ends with. */
export function ProjectPlanCard(props: {
  session: Session;
  doc: string;
  state: ProjectPlanState | null | undefined;
  onStarted?: (sessionId: string) => void;
  onChanged?: () => void;
}) {
  const reduce = useReducedMotion();
  const { milestones } = parseProjectPlan(props.doc);
  const done = milestones.filter((m) => m.done).length;
  return (
    <motion.section
      aria-label="Project plan options"
      data-project-plan-card
      // The plan settling is a rare moment: one short rise, nothing bouncy.
      initial={reduce ? false : { opacity: 0, transform: "translateY(6px)" }}
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      transition={{ duration: DUR.base, ease: EASE_OUT }}
      className="mt-6 rounded-xl border border-content/10"
    >
      <div className="flex items-center justify-between border-b border-content/10 px-3 py-2">
        <p className="text-[13px] font-medium">The plan is complete</p>
        <p className="text-xs tabular-nums text-content/50">
          {done} of {milestones.length} milestone{milestones.length === 1 ? "" : "s"} done
        </p>
      </div>
      <ProjectPlanOptions {...props} />
    </motion.section>
  );
}
