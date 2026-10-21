import type { BatchState, BatchStep, BatchStepId } from "@server/shared/contract-batch";
import { Check, CircleDashed } from "../../../chrome/icons";
import { MatrixSpinner, StatusDot } from "../bits";
import { mergedLine } from "./useMasterModel";

/**
 * The batch's own work under the list (docs/LAYOUT.md "Master"): what
 * happens when the children land. Three lines, not a panel, because they
 * are the batch's state and not a child's; they stay put while the list
 * scrolls. Read from `batch.get` (useBatchState).
 */

export const STEP_LABEL: Record<BatchStepId, string> = {
  land: "Merge queue",
  gate: "Gate once",
  release: "Release",
  deploy: "Deploy to the box",
};

function StepGlyph({ status }: { status: BatchStep["status"] }) {
  if (status === "done") return <Check className="size-3 text-success" strokeWidth={2.2} />;
  if (status === "running") return <MatrixSpinner cell={2} />;
  if (status === "failed") return <StatusDot status="error" />;
  return <CircleDashed className="size-3 text-content/30" strokeWidth={1.75} />;
}

export function BatchFoot({ batch }: { batch: BatchState }) {
  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-t border-content/10 px-4 pt-2.5 pb-3">
      <div className="flex items-center gap-2 text-xs text-content/50">
        <span>When the batch lands</span>
        <span className="flex-1" />
        <span className="tabular-nums">{mergedLine(batch)}</span>
      </div>
      <ol className="flex flex-col gap-0.5 text-xs">
        {batch.steps.map((step) => (
          <li key={step.id} className="grid grid-cols-[14px_auto_1fr] items-center gap-x-2 py-0.5" data-step={step.id} data-step-status={step.status}>
            <span className="flex justify-center">
              <StepGlyph status={step.status} />
            </span>
            <span className={step.status === "done" ? "text-content/50" : "text-content"}>{STEP_LABEL[step.id]}</span>
            <span className={`truncate ${step.status === "failed" ? "text-danger" : "text-content/40"}`} title={step.detail || undefined}>
              {step.detail}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
