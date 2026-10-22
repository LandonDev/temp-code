import type { BatchRules, BatchState, BatchStep } from "@server/shared/contract-batch";
import { duration } from "../bits";

/**
 * The batch's steps as the foot reads them (docs/LAYOUT.md "Master"). The
 * host's step telemetry: a status that ends in passed, failed or skipped,
 * when the step started and ended, its progress while it runs, and its
 * console lines. An older host's `done` step with only `at` reads the
 * same way. Pure, so the foot's rules are unit-tested without a DOM.
 */

export type StepStatus = "pending" | "running" | "passed" | "failed" | "skipped";

export type StepProgress = { done: number; total: number; label?: string };

export type LiveStep = {
  id: string;
  status: StepStatus;
  detail: string;
  startedAt?: number;
  endedAt?: number;
  progress?: StepProgress;
  /** The step's console lines, oldest first. */
  log: string[];
};

/** The wire step with the telemetry fields a host may add. */
type WireStep = Omit<BatchStep, "status"> & {
  status: BatchStep["status"] | StepStatus;
  startedAt?: number | null;
  endedAt?: number | null;
  progress?: StepProgress | null;
  log?: string[] | null;
};

/** The rules with the publish choice between release and deploy. */
export type RulesWithPublish = BatchRules & { publish?: boolean };

export const STEP_LABEL: Record<string, string> = {
  land: "Merging",
  gate: "Gate",
  release: "Release",
  publish: "Publish",
  deploy: "Deploy",
};

export function stepLabel(id: string): string {
  return (STEP_LABEL as Record<string, string>)[id] ?? id;
}

/** One step as the foot reads it; `batch` lends the land step its
 *  progress (landed of all) when the host sent none. */
export function liveStep(step: BatchStep, batch: Pick<BatchState, "landed" | "pending">): LiveStep {
  const wire = step as WireStep;
  const status: StepStatus = (wire.status as string) === "done" ? "passed" : wire.status;
  const ended = wire.endedAt ?? (status === "passed" || status === "failed" || status === "skipped" ? (wire.at ?? undefined) : undefined);
  const started = wire.startedAt ?? (status === "running" ? (wire.at ?? undefined) : undefined);
  let progress = wire.progress ?? undefined;
  if (!progress && step.id === "land") {
    const total = batch.landed.length + batch.pending.length;
    if (total > 0) progress = { done: batch.landed.length, total };
  }
  return {
    id: step.id,
    status,
    detail: step.detail,
    startedAt: started ?? undefined,
    endedAt: ended ?? undefined,
    progress,
    log: Array.isArray(wire.log) ? wire.log : [],
  };
}

export function liveSteps(batch: BatchState): LiveStep[] {
  return batch.steps.map((s) => liveStep(s, batch));
}

/** "4m 12s" for a finished step, the elapsed for a running one at `now`,
 *  null before it started. */
export function stepTime(step: Pick<LiveStep, "status" | "startedAt" | "endedAt">, now: number): string | null {
  if (step.startedAt === undefined) return null;
  if (step.status === "running") return duration(Math.max(0, now - step.startedAt));
  if (step.endedAt === undefined) return null;
  return duration(Math.max(0, step.endedAt - step.startedAt));
}

/** "3 of 7 · vitest" without the dot: "3 of 7" and the label apart. */
export function progressText(progress: StepProgress | undefined): { count: string; label: string | null; pct: number | null } | null {
  if (!progress) return null;
  const total = progress.total > 0 ? progress.total : null;
  return {
    count: total ? `${progress.done} of ${total}` : `${progress.done}`,
    label: progress.label?.trim() || null,
    pct: total ? Math.min(100, Math.round((progress.done / total) * 100)) : null,
  };
}

/** The step the console shows: the running one, else a failed one (it
 *  stays open until folded); null when the foot is idle. */
export function consoleStep(steps: readonly LiveStep[], folded: ReadonlySet<string>): LiveStep | null {
  return steps.find((s) => s.status === "running") ?? steps.find((s) => s.status === "failed" && !folded.has(s.id)) ?? null;
}

/** The last `limit` console lines, oldest first. */
export function tailLines(log: readonly string[], limit = 200): string[] {
  return log.length > limit ? log.slice(log.length - limit) : [...log];
}

/** Whether a scroller sits at (or within a few px of) its bottom: the
 *  console follows new lines while it does and stops once the person
 *  scrolled up. */
export function nearBottom(el: { scrollTop: number; scrollHeight: number; clientHeight: number }, slack = 8): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
}

/** The status word after a finished step's name in the console's lines
 *  above: nothing for passed (the check says it), the word otherwise. */
export function statusWord(status: StepStatus): string | null {
  if (status === "failed") return "failed";
  if (status === "skipped") return "skipped";
  return null;
}
