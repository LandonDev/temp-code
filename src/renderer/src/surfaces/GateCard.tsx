import type { GateNotice } from "@server/shared/gate";
import { failedGateStep, typecheckErrorCount } from "@server/shared/gate";
import { AlertCircle, Check, ChevronRight } from "../chrome/icons";
import type { Block } from "../lib/session";

/**
 * A gate run on one system row (shared/gate.ts): a batch child's typecheck
 * before its merge, a thread's commit tier, or the batch's own gate and
 * release on the master. A red run speaks up in the warning tone with its
 * last lines folded under the row; a green one is the quiet one-liner the
 * transcript already has. No actions: the fix is the thread's next turn.
 */
export function GateCard({ block }: { block: Block }) {
  const gate = block.gate;
  if (!gate) return null;
  const Icon = gate.ok ? Check : AlertCircle;
  const lines = gate.log.split("\n").filter((l) => l.trim()).length;
  return (
    <div className="flex min-w-0 flex-col gap-1.5 py-2 font-sans text-[12px]">
      <div className={`flex min-w-0 items-center gap-2 ${gate.ok ? "text-content/50" : "text-content"}`}>
        <Icon className={`size-3.5 shrink-0 ${gate.ok ? "" : "text-warning"}`} strokeWidth={1.75} />
        <span className="min-w-0 truncate">
          <span className="font-medium">{leadOf(gate)}</span>
          <span className={gate.ok ? "text-content/40" : "text-content/60"}> · {detailOf(gate)}</span>
        </span>
      </div>
      {lines && !gate.ok ? (
        <details className="group min-w-0">
          <summary className="flex cursor-default list-none items-center gap-1 text-content/40 hover:text-content/60 [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3 shrink-0 transition-transform duration-150 ease-out group-open:rotate-90" strokeWidth={1.75} />
            Last {lines === 1 ? "line" : `${lines} lines`}
          </summary>
          <pre className="ml-[7px] mt-1 min-w-0 overflow-x-auto whitespace-pre border-l border-content/10 pl-3 font-mono text-[11px] leading-[1.5] text-content/60">
            {gate.log}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

const STEP: Record<GateNotice["step"], string> = { typecheck: "Typecheck", gate: "Gate", release: "Release" };

function leadOf(gate: GateNotice): string {
  return `${STEP[gate.step]} ${gate.ok ? "passed" : "failed"}`;
}

/** "feature · 3 errors", "master · at vitest", "master · release-277" */
function detailOf(gate: GateNotice): string {
  const parts = [gate.branch];
  if (!gate.ok && gate.step === "typecheck") {
    const n = typecheckErrorCount(gate.log);
    if (n) parts.push(`${n} ${n === 1 ? "error" : "errors"}`);
  } else if (!gate.ok && gate.step === "gate") {
    const step = failedGateStep(gate.log);
    if (step) parts.push(`at ${step}`);
  } else if (gate.ok && gate.step === "release") {
    const tag = /tag (release-\d+)/.exec(gate.log)?.[1];
    if (tag) parts.push(tag);
  }
  return parts.join(" · ");
}
