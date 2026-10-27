// A9 (notices): the approval controls under an action row.
import { Button } from "../../components/ui/button";
import type { ApprovalDecision } from "../../lib/harness";
import { type Block } from "../../lib/session";
import { approvalDetailOf } from "../../lib/approvalDetail";

/** The decided approval's one line. */
function decidedLine(approval: NonNullable<Block["approval"]>): string {
  if (approval.decided === "allow") return "Allowed";
  return approval.auto ? "Denied, timed out" : "Denied";
}

/**
 * An approval's controls, under the action row that shows what it asks
 * (A8's row draws the command or the path). Undecided: a shell call's one
 * line of what it means to do, then Allow and Deny. Decided: one line.
 */
export function ApprovalControls({
  block,
  onApproval,
}: {
  block: Block;
  onApproval?: (requestId: string | number, decision: ApprovalDecision) => void;
}) {
  const approval = block.approval;
  if (!approval) return null;
  if (approval.decided) {
    return <div className="pl-5.5 font-sans text-xs leading-5 text-muted-foreground">{decidedLine(approval)}</div>;
  }
  const detail = approvalDetailOf(block);
  const reason = detail?.kind === "shell" ? detail.doing : null;
  return (
    <div className="flex min-w-0 flex-col gap-2 pb-2 pl-5.5 font-sans">
      {reason ? <span className="min-w-0 truncate text-[13px] leading-5 text-muted-foreground">{reason}</span> : null}
      <div className="flex gap-2">
        <Button size="sm" onClick={() => onApproval?.(approval.requestId, "allow")}>
          Allow
        </Button>
        <Button size="sm" variant="secondary" onClick={() => onApproval?.(approval.requestId, "deny")}>
          Deny
        </Button>
      </div>
    </div>
  );
}
