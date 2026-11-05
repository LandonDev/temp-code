import { useState } from "react";
import type { GateNotice } from "@server/shared/gate";
import { gateReason, typecheckErrorCount } from "@server/shared/gate";
import { Collapsible } from "../components/ui/collapsible";
import { CONSOLE } from "../components/ui/console";
import { StatusMark } from "../components/ui/status";
import { cn } from "../lib/cn";
import type { Block } from "../lib/session";
import { NoticeLine } from "./transcript/NoticeLine";

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
      fold={foldable ? { open, label: open ? "Hide the log" : "Show the log" } : undefined}
    >
      {foldable ? (
        // The one console, starting at the glyph's edge as every opened body
        // does; inside a group's table, or a card, it draws no card of its own.
        <pre
          data-slot="gate-log"
          tabIndex={0}
          className={cn(
            CONSOLE,
            "mt-1 mb-2 -ml-5.5 min-w-0 overflow-x-auto whitespace-pre",
            "in-[.bg-card]:ml-0 in-[.bg-card]:rounded-none in-[.bg-card]:[--scrollbar-inset:0px] in-[.bg-card]:bg-transparent in-[.bg-card]:px-0",
            "in-data-[table]:my-0 in-data-[table]:ml-0 in-data-[table]:rounded-none in-data-[table]:[--scrollbar-inset:0px] in-data-[table]:bg-transparent in-data-[table]:px-0 in-data-[table]:py-0",
          )}
        >
          {gate.log}
        </pre>
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

/** The lead ends in "on" so the branch after it reads as one phrase, as shared gateLine says it ("Gate failed on master, at vitest"). */
function leadOf(gate: GateNotice): string {
  return `${STEP[gate.step]} ${gate.ok ? "passed" : "failed"} on`;
}

/** ["feature", "3 errors"], ["master", "at vitest"], ["master", "error: Module not found"], ["master", "release-277"] */
export function detailOf(gate: GateNotice): string[] {
  const parts = [gate.branch];
  if (!gate.ok && gate.step === "typecheck") {
    const n = typecheckErrorCount(gate.log);
    if (n) parts.push(`${n} ${n === 1 ? "error" : "errors"}`);
  } else if (!gate.ok) {
    const reason = gateReason(gate.log);
    if (reason) parts.push(reason);
  } else if (gate.ok && gate.step === "release") {
    const tag = /tag (release-\d+)/.exec(gate.log)?.[1];
    if (tag) parts.push(tag);
  }
  return parts;
}
