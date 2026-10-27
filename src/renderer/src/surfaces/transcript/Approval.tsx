// A9 (notices): the approval controls and detail.
import type { ApprovalDecision } from "../../lib/harness";
import { type Block } from "../../lib/session";
import { approvalDetailOf, approvalOutcome } from "../../lib/approvalDetail";

export function ApprovalControls({
  block,
  onApproval,
}: {
  block: Block;
  onApproval?: (requestId: string | number, decision: ApprovalDecision) => void;
}) {
  const approval = block.approval;
  if (!approval) return null;
  const detail = approvalDetailOf(block);
  const outcome = approvalOutcome(approval);
  if (approval.decided) {
    return outcome ? (
      <div className="mt-1 font-sans text-[11px] text-content/40">{outcome}</div>
    ) : null;
  }
  return (
    <div className="mt-1.5 flex flex-col gap-2">
      {detail ? <ApprovalDetailView detail={detail} /> : null}
      <div className="flex gap-2">
      <button
        type="button"
        className="rounded-md bg-content px-2.5 py-0.5 text-[11px] hover:bg-content/70     text-background-base"
        onClick={() => onApproval?.(approval.requestId, "allow")}
      >
        Allow
      </button>
      <button
        type="button"
        className="rounded-md bg-content/10 px-2.5 py-0.5 text-[11px] text-content/70 hover:bg-content/20"
        onClick={() => onApproval?.(approval.requestId, "deny")}
      >
        Deny
      </button>
      </div>
    </div>
  );
}

/** What the agent is asking to do, in the words the board can decide on. */
export function ApprovalDetailView({
  detail,
}: {
  detail: NonNullable<ReturnType<typeof approvalDetailOf>>;
}) {
  if (detail.kind === "shell") {
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <span className="font-sans text-[12px] text-content/70">{detail.doing}</span>
        <pre className="min-w-0 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md bg-content/6 px-2 py-1 text-[12px] text-content/70">
          {detail.command}
        </pre>
      </div>
    );
  }
  if (detail.kind === "file") {
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <span className="font-sans text-[12px] text-content/70">Write {detail.path}</span>
        {detail.added.length ? (
          <pre className="min-w-0 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md bg-content/6 px-2 py-1 text-[12px] text-content/70">
            {detail.added.join("\n")}
            {detail.more ? "\n…" : null}
          </pre>
        ) : null}
      </div>
    );
  }
  return (
    <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px]">
      {detail.entries.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-content/40">{key}</dt>
          <dd className="min-w-0 truncate text-content/70">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
