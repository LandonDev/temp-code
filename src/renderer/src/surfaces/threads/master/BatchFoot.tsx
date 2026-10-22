import { useReducedMotion } from "motion/react";
import { useLayoutEffect, useRef, useState } from "react";
import type { BatchState } from "@server/shared/contract-batch";
import { Check, ChevronDown, CircleDashed, Square } from "../../../chrome/icons";
import { TweenHeight } from "../../../motion";
import { MatrixSpinner, StatusDot, useNow } from "../bits";
import { RulesDialog } from "./RulesDialog";
import { consoleStep, liveSteps, nearBottom, progressText, stepTime, statusWord, tailLines, type LiveStep, type StepStatus } from "./steps";
import { blockedLine, rulesSentence, type Rules } from "./useMasterModel";

/**
 * Under the list, what happens when the threads are done (docs/LAYOUT.md
 * "Master"): the master's summary line when it wrote one and the rules as
 * one sentence with Edit beside it, then the steps the master wrote, in
 * order. Idle, the steps are one quiet row: state, name and, once
 * finished, how long it took. The moment a step runs the foot grows to
 * its console, the same for a shell step as for a publish: the step's
 * name with its elapsed ticking, its progress and a bar when the total is
 * known, its console lines newest at the bottom (following until the
 * person scrolls up), Stop at the right; the steps before it keep their
 * state and time in a line above. A failed step stays open with its last
 * lines until folded. Every step done, the foot shrinks back to the row.
 * The grow and shrink are the app's height tween (200 ms, the ease-out
 * curve), a snap under reduced motion. Read from `batch.get` and the
 * `batch` push; Edit writes `batch.setRules`, Stop `batch.stopStep` with
 * the step's id.
 */

const LOG_LINES = 200;

function StepGlyph({ status, dim = false }: { status: StepStatus; dim?: boolean }) {
  if (status === "passed") return <Check className={`size-3 ${dim ? "text-content/35" : "text-success"}`} strokeWidth={2.2} />;
  if (status === "running") return <MatrixSpinner cell={1.5} />;
  if (status === "failed") return <StatusDot status="error" />;
  return <CircleDashed className="size-3 text-content/30" strokeWidth={1.75} />;
}

export function BatchFoot({
  batch,
  titleOf,
  onSave,
  onStop,
}: {
  batch: BatchState;
  /** A child's title by id, for the blocked line. */
  titleOf: (id: string) => string | undefined;
  onSave: (rules: Rules) => Promise<void>;
  onStop: (stepId: string) => Promise<void>;
}) {
  const rules = batch.rules;
  const [editing, setEditing] = useState(false);
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const steps = liveSteps(batch);
  const active = consoleStep(steps, folded);
  const running = steps.some((s) => s.status === "running");
  // A step that runs again after a fold unfolds it.
  if (running && folded.size > 0) setFolded(new Set());
  const now = useNow(running);
  const reduce = useReducedMotion();
  const blocked = blockedLine(batch, titleOf);

  return (
    <div className="flex shrink-0 flex-col border-t border-content/10 px-4 pt-2.5 pb-3" data-batch-foot data-foot-mode={active ? "console" : "idle"}>
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-xs text-content/40">When the threads are done</span>
          {rules.summary ? <span className="text-xs text-content">{rules.summary}</span> : null}
          <span className="text-xs leading-4 text-content/60" data-rules>
            {rulesSentence(rules)}
          </span>
          {blocked ? (
            <span className="text-xs leading-4 text-danger" data-blocked>
              {blocked}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="pressable -mt-0.5 h-6 shrink-0 rounded-md px-2 text-xs text-content/50 hover:bg-content/5 hover:text-content"
        >
          Edit
        </button>
      </div>

      {/* Both stay mounted so the closing one can tween shut; the closed one is inert. */}
      <TweenHeight open={!active} animate={!reduce}>
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-2 text-xs" data-steps-row inert={!!active} aria-hidden={!!active}>
          {steps.map((step) => (
            <StepLine key={step.id} step={step} now={now} />
          ))}
        </ul>
      </TweenHeight>

      <TweenHeight open={!!active} animate={!reduce}>
        {active ? (
          <Console
            steps={steps}
            active={active}
            now={now}
            onStop={() => onStop(active.id)}
            onFold={() => setFolded(new Set([...folded, active.id]))}
          />
        ) : null}
      </TweenHeight>

      {editing ? <RulesDialog rules={rules} onClose={() => setEditing(false)} onSave={onSave} /> : null}
    </div>
  );
}

/** One step in a line: its glyph, its name, its time; the status word when
 *  the glyph alone does not say it. */
function StepLine({ step, now }: { step: LiveStep; now: number }) {
  const time = stepTime(step, now);
  const word = statusWord(step.status);
  const pending = step.status === "pending" || step.status === "skipped";
  return (
    <li className="flex items-center gap-1.5 whitespace-nowrap" data-step={step.id} data-step-status={step.status}>
      <StepGlyph status={step.status} dim />
      <span className={pending ? "text-content/40" : step.status === "failed" ? "text-danger" : "text-content/70"}>{step.name}</span>
      {word && step.status !== "failed" ? <span className="text-content/40">{word}</span> : null}
      {time ? (
        <span className="tabular-nums text-content/40" data-step-time>
          {time}
        </span>
      ) : null}
    </li>
  );
}

function Console({
  steps,
  active,
  now,
  onStop,
  onFold,
}: {
  steps: LiveStep[];
  active: LiveStep;
  now: number;
  onStop: () => Promise<void>;
  onFold: () => void;
}) {
  const at = steps.findIndex((s) => s.id === active.id);
  const before = steps.slice(0, at);
  const after = steps.slice(at + 1);
  const failed = active.status === "failed";
  const progress = progressText(active.progress);
  const lines = tailLines(active.log, LOG_LINES);
  const logRef = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  const [stopping, setStopping] = useState(false);

  // The console follows its newest line while the person has not scrolled
  // up; a new step starts at the bottom again.
  useLayoutEffect(() => {
    follow.current = true;
  }, [active.id]);
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [lines.length, active.id]);

  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    try {
      await onStop();
    } finally {
      setStopping(false);
    }
  };

  return (
    <div className="flex flex-col gap-1 pt-2" data-console={active.id}>
      {before.length > 0 ? (
        <ul className="flex flex-col gap-0.5 text-xs">
          {before.map((step) => (
            <StepLine key={step.id} step={step} now={now} />
          ))}
        </ul>
      ) : null}

      <div className="flex h-6 items-center gap-2 text-xs" data-console-head>
        <span className="flex w-3 justify-center">
          <StepGlyph status={active.status} />
        </span>
        <span className={`font-medium ${failed ? "text-danger" : "text-content"}`}>{active.name}</span>
        {active.kind === "shell" && active.run ? (
          <span className="min-w-0 truncate font-mono text-[11px] text-content/40" data-step-run>
            {active.run}
          </span>
        ) : null}
        {failed ? <span className="text-danger">failed</span> : null}
        <span className="tabular-nums text-content/50" data-step-time>
          {stepTime(active, now)}
        </span>
        {progress ? (
          <span className="min-w-0 truncate text-content/50" data-progress>
            <span className="tabular-nums">{progress.count}</span>
            {progress.label ? <span className="text-content/40"> {progress.label}</span> : null}
          </span>
        ) : null}
        <span className="flex-1" />
        {failed ? (
          <button
            type="button"
            onClick={onFold}
            className="pressable inline-flex h-6 items-center gap-0.5 rounded-md px-2 text-xs text-content/50 hover:bg-content/5 hover:text-content"
          >
            Hide
            <ChevronDown className="size-3" strokeWidth={1.75} />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void stop()}
            disabled={stopping}
            className="pressable inline-flex h-6 items-center gap-1 rounded-md px-2 text-xs text-content/60 hover:bg-content/5 hover:text-content disabled:opacity-40"
          >
            <Square className="size-2.5" strokeWidth={2} />
            Stop
          </button>
        )}
      </div>

      {progress?.pct !== null && progress?.pct !== undefined ? (
        <div className="ml-5 h-0.5 overflow-hidden rounded-full bg-content/10" role="progressbar" aria-valuenow={progress.pct} aria-valuemin={0} aria-valuemax={100}>
          <div
            className={`h-full rounded-full ${failed ? "bg-danger" : "bg-content/50"}`}
            style={{ transform: `scaleX(${progress.pct / 100})`, transformOrigin: "left", transition: "transform 200ms linear" }}
          />
        </div>
      ) : null}

      <pre
        ref={logRef}
        onScroll={(e) => {
          follow.current = nearBottom(e.currentTarget);
        }}
        data-log
        className="ml-5 max-h-44 min-h-[3.75rem] overflow-y-auto whitespace-pre-wrap rounded-md bg-content/4 px-2.5 py-2 font-mono text-[11px] leading-[1.5] text-content/60"
      >
        {lines.length > 0 ? lines.join("\n") : <span className="text-content/35">{failed ? "No output" : "Starting…"}</span>}
        {failed && active.detail ? <span className="block pt-1 text-danger">{active.detail}</span> : null}
      </pre>

      {after.length > 0 ? (
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-0.5 text-xs">
          {after.map((step) => (
            <StepLine key={step.id} step={step} now={now} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
