// A9 (notices): the approval under an action row.
import { Button } from "../../components/ui/button";
import { StatusMark } from "../../components/ui/status";
import type { ApprovalDecision } from "../../lib/harness";
import { type Block } from "../../lib/session";

/** The decided approval's one line. */
export function decidedLine(approval: NonNullable<Block["approval"]>): string {
  if (approval.decided === "allow") return "Allowed";
  return approval.auto ? "Denied, timed out" : "Denied";
}

/**
 * An approval, under the action row that already says what it asks (the
 * command, the path). Undecided: one line, why it waits in the status
 * vocabulary's words, then Allow and Deny. Decided: the verdict, one line.
 * Not a bordered card: it sits inside the action list's own.
 */
export function ApprovalCard({
  block,
  onApproval,
}: {
  block: Block;
  onApproval?: (requestId: string | number, decision: ApprovalDecision) => void;
}) {
  const approval = block.approval;
  if (!approval) return null;
  if (approval.decided) {
    return (
      <div data-slot="approval" className="flex min-h-8 items-center pl-5.5 font-sans text-xs text-muted-foreground">
        {decidedLine(approval)}
      </div>
    );
  }
  return (
    <div data-slot="approval" className="flex min-h-8 min-w-0 items-center gap-2 pb-1 pl-5.5 font-sans">
      <StatusMark state="waiting" word={false} />
      <Button size="sm" onClick={() => onApproval?.(approval.requestId, "allow")}>
        Allow
      </Button>
      <Button size="sm" variant="secondary" onClick={() => onApproval?.(approval.requestId, "deny")}>
        Deny
      </Button>
    </div>
  );
}
