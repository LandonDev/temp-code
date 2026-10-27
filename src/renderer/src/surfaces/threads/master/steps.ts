import {
  BatchStepKindSchema,
  DEFAULT_BATCH_STEPS,
  type BatchRules,
  type BatchState,
  type BatchStep,
  type BatchStepKind,
  type BatchStepSpec,
} from "@server/shared/contract-batch";
import type { ThreadState } from "../../../components/ui/status";
import { duration } from "../../../lib/duration";

/**
 * The batch's steps as the foot reads them (docs/LAYOUT.md "Master"): the
 * list the master wrote (`rules.steps`: id, name, kind, a shell step's
 * command) joined with the host's telemetry per step (`state.steps`: a
 * status that ends in passed, failed or skipped, when it started and
 * ended, its progress while it runs, its console lines). The state's
 * order is the order; a step the rules name that the state has not seen
 * yet is pending at the end. Nothing here knows a step by name. Pure, so
 * the foot's rules are unit-tested without a DOM.
 */

export type StepStatus = "pending" | "running" | "passed" | "failed" | "skipped";

export type StepProgress = { done: number; total: number; label?: string };

export type LiveStep = {
  id: string;
  /** The master's name for the step. */
  name: string;
  kind: BatchStepKind;
  /** A shell step's command. */
  run?: string;
  status: StepStatus;
  detail: string;
  startedAt?: number;
  endedAt?: number;
  progress?: StepProgress;
  /** The step's console lines, oldest first. */
  log: string[];
};

/** The wire step with the telemetry fields a host may add; an older host
 *  sends no name or kind, so both are optional here. */
type WireStep = Omit<BatchStep, "status" | "id" | "name" | "kind"> & {
  id: string;
  name?: string;
  kind?: BatchStepKind;
  status: BatchStep["status"] | StepStatus;
  startedAt?: number | null;
  endedAt?: number | null;
  progress?: StepProgress | null;
  log?: string[] | null;
};

/** The rules' step list; the contract's default list for a host that sent none. */
export function stepsOf(rules: Pick<BatchRules, "steps">): BatchStepSpec[] {
  return rules.steps ?? DEFAULT_BATCH_STEPS;
}

/** The spec of a step the state names: the rules' row, else one made from
 *  the id (its kind when the id is one, else a shell step). */
export function specOf(id: string, specs: readonly BatchStepSpec[]): BatchStepSpec {
  const spec = specs.find((s) => s.id === id);
  if (spec) return spec;
  const kind = BatchStepKindSchema.safeParse(id);
  return { id, name: id, kind: kind.success ? kind.data : "shell" };
}

/** The state's own name and kind when the host sent them (the step row
 *  carries both), else the rules' row for the id. */
function describe(wire: WireStep, specs: readonly BatchStepSpec[]): BatchStepSpec {
  const spec = specOf(wire.id, specs);
  return { ...spec, name: wire.name || spec.name, kind: wire.kind ?? spec.kind };
}

/** One step as the foot reads it; `batch` lends a land step its
 *  progress (landed of all) when the host sent none. */
export function liveStep(step: BatchStep, batch: Pick<BatchState, "landed" | "pending">, specs: readonly BatchStepSpec[] = []): LiveStep {
  const wire = step as WireStep;
  const spec = describe(wire, specs);
  const status: StepStatus = (wire.status as string) === "done" ? "passed" : wire.status;
  const ended = wire.endedAt ?? (status === "passed" || status === "failed" || status === "skipped" ? (wire.at ?? undefined) : undefined);
  const started = wire.startedAt ?? (status === "running" ? (wire.at ?? undefined) : undefined);
  let progress = wire.progress ?? undefined;
  if (!progress && spec.kind === "land") {
    const total = batch.landed.length + batch.pending.length;
    if (total > 0) progress = { done: batch.landed.length, total };
  }
  return {
    id: wire.id,
    name: spec.name,
    kind: spec.kind,
    ...(spec.run ? { run: spec.run } : {}),
    status,
    detail: step.detail,
    startedAt: started ?? undefined,
    endedAt: ended ?? undefined,
    progress,
    log: Array.isArray(wire.log) ? wire.log : [],
  };
}

/** A step the rules name that the host has not started: pending, no log. */
export function pendingStep(spec: BatchStepSpec): LiveStep {
  return { id: spec.id, name: spec.name, kind: spec.kind, ...(spec.run ? { run: spec.run } : {}), status: "pending", detail: "", log: [] };
}

export function liveSteps(batch: BatchState): LiveStep[] {
  const specs = stepsOf(batch.rules);
  const seen = new Set<string>();
  const steps: LiveStep[] = [];
  for (const step of batch.steps) {
    seen.add(step.id);
    steps.push(liveStep(step, batch, specs));
  }
  for (const spec of specs) if (!seen.has(spec.id)) steps.push(pendingStep(spec));
  return steps;
}

/** "4m 12s" for a finished step, the elapsed for a running one at `now`,
 *  null before it started. */
export function stepTime(step: Pick<LiveStep, "status" | "startedAt" | "endedAt">, now: number): string | null {
  if (step.startedAt === undefined) return null;
  if (step.status === "running") return duration(Math.max(0, now - step.startedAt));
  if (step.endedAt === undefined) return null;
  return duration(Math.max(0, step.endedAt - step.startedAt));
}

/** Progress as a count and its label: "3 of 7" and "vitest", set apart by margin. */
export function progressText(progress: StepProgress | undefined): { count: string; label: string | null } | null {
  if (!progress) return null;
  return { count: progress.total > 0 ? `${progress.done} of ${progress.total}` : `${progress.done}`, label: progress.label?.trim() || null };
}

/** A step's status in the status vocabulary: pending is queued, running
 *  working, passed done, failed failed, skipped idle. */
export function stepState(status: StepStatus): ThreadState {
  switch (status) {
    case "pending":
      return "queued";
    case "running":
      return "working";
    case "passed":
      return "done";
    case "failed":
      return "failed";
    case "skipped":
      return "idle";
  }
}

/** What a step's row says after its name: the land step how branches
 *  land until it runs, then how many landed; a running step its progress;
 *  a skipped one the host's reason, else "skipped"; otherwise the host's
 *  detail. A shell step's command is never the row's: its console opens
 *  with `$ <run>`. */
export function stepDetail(step: Pick<LiveStep, "kind" | "status" | "detail" | "progress">, rules: Pick<BatchRules, "land">): { text: string; label: string | null } {
  const plain = (text: string) => ({ text, label: null });
  if (step.kind === "land") {
    if (step.status === "pending") return plain(rules.land === "all-at-once" ? "all at once" : "as they finish");
    if (step.progress && step.progress.total > 0) return plain(`${step.progress.done} of ${step.progress.total} landed`);
  }
  if (step.status === "skipped") return plain(step.detail.trim() || "skipped");
  if (step.status === "running") {
    const progress = progressText(step.progress);
    if (progress) return { text: progress.count, label: progress.label };
  }
  return plain(step.detail.trim());
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
