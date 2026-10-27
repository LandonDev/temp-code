import { useState } from "react";
import type { GateNotice } from "@server/shared/gate";
import { failedGateStep, typecheckErrorCount } from "@server/shared/gate";
import { Collapsible, CollapsibleContent } from "../components/ui/collapsible";
import { StatusMark } from "../components/ui/status";
import type { Block } from "../lib/session";
import { NoticeCaret, NoticeLine } from "./transcript/NoticeLine";

/**
 * A gate run on one notice line (shared/gate.ts): a batch child's typecheck
 * before its merge, a thread's commit tier, or the batch's own gate and
 * release on the master. A green run is a quiet line; a red one sets its
 * lead in the foreground with the failed glyph, and its last lines open
 * under the caret. No actions: the fix is the thread's next turn.
 */
export function GateCard({ block }: { block: Block }) {
  const [open, setOpen] = useState(false);
  const gate = block.gate;
  if (!gate) return null;
  const lines = gate.log.split("\n").filter((l) => l.trim()).length;
  const foldable = !gate.ok && lines > 0;
  const line = (
    <NoticeLine
      data-state={gate.ok ? "done" : "failed"}
      glyph={<StatusMark state={gate.ok ? "done" : "failed"} word={false} />}
      lead={leadOf(gate)}
      tone={gate.ok ? "muted" : "strong"}
      details={detailOf(gate)}
      trailing={foldable ? <NoticeCaret open={open} label={open ? "Hide the log" : "Show the log"} /> : undefined}
    >
      {foldable ? (
        <CollapsibleContent>
          <pre className="mt-1 mb-2 min-w-0 overflow-x-auto whitespace-pre rounded-lg border border-border bg-card px-3 py-2 font-mono text-xs leading-5 text-muted-foreground">
            {gate.log}
          </pre>
        </CollapsibleContent>
      ) : null}
    </NoticeLine>
  );
  return foldable ? (
    <Collapsible open={open} onOpenChange={setOpen}>
      {line}
    </Collapsible>
  ) : (
    line
  );
}

const STEP: Record<GateNotice["step"], string> = { typecheck: "Typecheck", gate: "Gate", release: "Release" };

function leadOf(gate: GateNotice): string {
  return `${STEP[gate.step]} ${gate.ok ? "passed" : "failed"}`;
}

/** ["feature", "3 errors"], ["master", "at vitest"], ["master", "release-277"] */
export function detailOf(gate: GateNotice): string[] {
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
  return parts;
}
