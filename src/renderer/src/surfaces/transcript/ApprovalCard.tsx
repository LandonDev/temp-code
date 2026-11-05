// A9 (notices): the approval under an action row.
import { useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { loadToast } from "../../components/ui/toaster";
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
 * Inside an open group's table it keeps the table's grid: the mark under the
 * row glyph (12px in) and the verdict under the row's words (12 + 22px).
 * A click draws the verdict at once, before the host's decided row comes
 * back, so a second click can send nothing more; a decision the host never
 * took puts the buttons back and says so in a toast.
 */
export function ApprovalCard({
  block,
  onApproval,
}: {
  block: Block;
  onApproval?: (requestId: string | number, decision: ApprovalDecision) => void | Promise<unknown>;
}) {
  const approval = block.approval;
  // Seen waiting on this mount: only then is the verdict news worth a fade.
  const sawWaiting = useRef(!!approval && !approval.decided);
  const [sent, setSent] = useState<ApprovalDecision | null>(null);
  if (!approval) return null;
  const decide = (decision: ApprovalDecision) => {
    if (sent) return;
    setSent(decision);
    const delivered = onApproval?.(approval.requestId, decision);
    void Promise.resolve(delivered).catch(() => {
      setSent(null);
      void loadToast().then((toast) => toast.error("Couldn't send the decision"));
    });
  };
  if (approval.decided || sent) {
    return (
      <div
        data-slot="approval"
        className={cn(
          "flex min-h-7 items-center pl-5.5 in-data-[table]:pl-8.5 font-sans text-[13px] leading-5 text-muted-foreground",
          sawWaiting.current && "animate-in fade-in-0 duration-(--dur-fast) ease-(--ease-out) motion-reduce:animate-none",
        )}
      >
        {approval.decided ? decidedLine(approval) : decidedLine({ ...approval, decided: sent ?? undefined })}
      </div>
    );
  }
  return (
    <div data-slot="approval" className="flex min-h-7 min-w-0 items-center gap-2 in-data-[table]:px-3 font-sans">
      <span data-approval-mark className="flex w-3.5 shrink-0 justify-center">
        <StatusMark state="waiting" word={false} />
      </span>
      <Button size="sm" onClick={() => decide("allow")}>
        Allow
      </Button>
      <Button size="sm" variant="secondary" onClick={() => decide("deny")}>
        Deny
      </Button>
    </div>
  );
}
