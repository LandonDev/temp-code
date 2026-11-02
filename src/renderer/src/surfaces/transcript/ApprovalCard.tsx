// A9 (notices): the approval under an action row.
import { useRef } from "react";
import { Button } from "../../components/ui/button";
import { StatusMark } from "../../components/ui/status";
import type { ApprovalDecision } from "../../lib/harness";
import { cn } from "../../lib/cn";
import { type Block } from "../../lib/session";

/** The decided approval's one line. An automatic denial is a timeout or a
 *  person's Stop, and the event does not say which, so the line says neither. */
export function decidedLine(approval: NonNullable<Block["approval"]>): string {
  if (approval.decided === "allow") return "Allowed";
  return approval.auto ? "Denied automatically" : "Denied";
}

/**
 * An approval, under the action row that already says what it asks (the
 * command, the path). Undecided: one 28px line, the amber mark in the row's
 * glyph column and Allow and Deny where the row's words start. Decided: the
 * verdict, one muted line at the words, fading in when the decision lands on
 * screen (a verdict that mounts decided just shows). Not a bordered card.
 */
export function ApprovalCard({
  block,
  onApproval,
}: {
  block: Block;
  onApproval?: (requestId: string | number, decision: ApprovalDecision) => void;
}) {
  const approval = block.approval;
  // Seen waiting on this mount: only then is the verdict news worth a fade.
  const sawWaiting = useRef(!!approval && !approval.decided);
  if (!approval) return null;
  if (approval.decided) {
    return (
      <div
        data-slot="approval"
        className={cn(
          "flex min-h-7 items-center pl-5.5 font-sans text-[13px] leading-5 text-muted-foreground",
          sawWaiting.current && "animate-in fade-in-0 duration-(--dur-fast) ease-(--ease-out) motion-reduce:animate-none",
        )}
      >
        {decidedLine(approval)}
      </div>
    );
  }
  return (
    <div data-slot="approval" className="flex min-h-7 min-w-0 items-center gap-2 font-sans">
      <span data-approval-mark className="flex w-3.5 shrink-0 justify-center">
        <StatusMark state="waiting" word={false} />
      </span>
      <Button size="sm" onClick={() => onApproval?.(approval.requestId, "allow")}>
        Allow
      </Button>
      <Button size="sm" variant="secondary" onClick={() => onApproval?.(approval.requestId, "deny")}>
        Deny
      </Button>
    </div>
  );
}
