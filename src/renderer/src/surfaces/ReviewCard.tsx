import { useContext, useState } from "react";
import type { ReviewFinding } from "@server/shared/review";
import { AlertCircle, Check, ChevronRight, CircleDashed } from "../chrome/icons";
import type { Block } from "../lib/session";
import { mergeAnyway } from "../lib/tcserver/commands";
import { useMetaById, modelLabel } from "../lib/threads/agents";
import type { OpenFileFn } from "../lib/search";
import { SelectSessionContext } from "./AgentMarkdown";
import { useOpenAgentDetail } from "./agentDetailContext";
import { CHIP } from "./chip";
import { useTranscriptSession } from "./transcriptSession";

/**
 * A merge review's outcome on one system row (shared/review.ts): who
 * reviewed, what it found, whether the merge landed. A held review lists
 * its blocking findings with the file and line to open, the reviewer thread
 * is one chip away, and "Merge anyway" is the person's override. Everything
 * else reads as the quiet one-liners the transcript already has.
 */
export function ReviewCard({
  block,
  cwd,
  onOpenFile,
}: {
  block: Block;
  cwd?: string;
  onOpenFile?: OpenFileFn;
}) {
  const review = block.review;
  const sessionId = useTranscriptSession();
  const reviewer = useMetaById(review?.reviewerId ?? null);
  const openDetail = useOpenAgentDetail();
  const onSelectSession = useContext(SelectSessionContext);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!review) return null;
  const open = openDetail ?? onSelectSession;
  const label = modelLabel(review.provider, review.model);
  const held = review.outcome === "held" && !review.resolved;
  // Only a live hold speaks up; every settled outcome is a quiet line.
  const tone = held ? "warn" : "muted";
  const Icon = review.outcome === "held" ? AlertCircle : review.outcome === "timeout" || review.outcome === "failed" ? CircleDashed : Check;
  const minor = review.minor.length;
  const blocking = review.blocking.length;
  const lead = leadOf(review.outcome, label);
  const detail = detailOf(review.outcome, blocking, minor, review.minutes, review.reason, review.resolved);

  const merge = async () => {
    if (!sessionId || pending) return;
    setPending(true);
    setError(null);
    try {
      await mergeAnyway(sessionId, review.runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPending(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-1.5 py-2 font-sans text-[12px]">
      <div className={`flex min-w-0 items-center gap-2 ${tone === "warn" ? "text-content" : "text-content/50"}`}>
        <Icon className={`size-3.5 shrink-0 ${tone === "warn" ? "text-warning" : ""}`} strokeWidth={1.75} />
        <span className="min-w-0 truncate">
          <span className="font-medium">{lead}</span>
          {detail ? <span className={tone === "warn" ? "text-content/60" : "text-content/40"}> · {detail}</span> : null}
        </span>
        {review.reviewerId ? (
          <button
            type="button"
            disabled={!open}
            title={reviewer?.title ?? "Open the review thread"}
            className="pressable -my-0.5 ml-auto shrink-0 rounded-md bg-content/6 px-1.5 py-0.5 text-[11px] text-content/60 enabled:hover:bg-content/10 enabled:hover:text-content"
            onClick={(event) => {
              event.stopPropagation();
              open?.(review.reviewerId!);
            }}
          >
            Review thread
          </button>
        ) : null}
      </div>
      {blocking ? (
        <FindingList findings={review.blocking} cwd={cwd} onOpenFile={onOpenFile} strong={held} />
      ) : null}
      {minor ? (
        <details className="group min-w-0">
          <summary className="flex cursor-default list-none items-center gap-1 text-content/40 hover:text-content/60 [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3 shrink-0 transition-transform duration-150 ease-out group-open:rotate-90" strokeWidth={1.75} />
            {minor} minor {minor === 1 ? "finding" : "findings"}, not blocking
          </summary>
          <div className="pt-1">
            <FindingList findings={review.minor} cwd={cwd} onOpenFile={onOpenFile} strong={false} />
          </div>
        </details>
      ) : null}
      {held ? (
        <div className="flex min-w-0 items-center gap-2 pt-0.5">
          <button type="button" className={CHIP} disabled={pending || !sessionId} onClick={merge}>
            {pending ? "Merging…" : "Merge anyway"}
          </button>
          <span className="min-w-0 truncate text-content/40">
            {error ? <span className="text-danger">{error}</span> : "Address the findings and merge again, or merge past them."}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function leadOf(outcome: NonNullable<Block["review"]>["outcome"], label: string): string {
  switch (outcome) {
    case "pass":
    case "held":
      return `Reviewed by ${label}`;
    case "timeout":
      return `Review by ${label} timed out`;
    case "failed":
      return `Review by ${label} did not run`;
    case "merged-anyway":
      return "Merged anyway";
    case "skipped":
      return "Merged";
  }
}

function detailOf(
  outcome: NonNullable<Block["review"]>["outcome"],
  blocking: number,
  minor: number,
  minutes: number | undefined,
  reason: string | undefined,
  resolved: boolean | undefined,
): string {
  const minorText = minor ? `${minor} minor` : "";
  switch (outcome) {
    case "pass":
      return ["no blocking findings", minorText].filter(Boolean).join(", ");
    case "held":
      return [`${blocking} blocking ${blocking === 1 ? "finding" : "findings"}`, minorText, resolved ? "merged anyway" : "merge held"].filter(Boolean).join(", ");
    case "timeout":
      return `after ${minutes ?? "?"} min, merged without it`;
    case "failed":
      return [reason, "merged without it"].filter(Boolean).join(", ");
    case "merged-anyway":
      return `${blocking} blocking ${blocking === 1 ? "finding" : "findings"} overridden`;
    case "skipped":
      return reason ?? "";
  }
}

/** The findings as rows: the place to open, the claim, the failure. */
function FindingList({
  findings,
  cwd,
  onOpenFile,
  strong,
}: {
  findings: ReviewFinding[];
  cwd?: string;
  onOpenFile?: OpenFileFn;
  strong: boolean;
}) {
  return (
    <ol className="ml-[7px] flex min-w-0 flex-col gap-1.5 border-l border-content/10 pl-3">
      {findings.map((f, i) => {
        const where = `${f.file}${f.line ? `:${f.line}` : ""}`;
        const path = cwd && !f.file.startsWith("/") ? `${cwd.replace(/\/$/, "")}/${f.file}` : f.file;
        return (
          <li key={`${where}:${i}`} className="flex min-w-0 flex-col gap-0.5">
            <div className="flex min-w-0 items-baseline gap-1.5">
              <button
                type="button"
                disabled={!onOpenFile}
                title={path}
                className="pressable shrink-0 rounded-md bg-content/6 px-1 py-px font-mono text-[11px] text-content/70 enabled:hover:bg-content/10 enabled:hover:text-content disabled:cursor-default"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenFile?.(path, f.line ? { line: f.line } : undefined);
                }}
              >
                {where}
              </button>
              {f.verdict === "PLAUSIBLE" ? <span className="shrink-0 text-[11px] text-content/40">plausible</span> : null}
              <span className={`min-w-0 break-words ${strong ? "text-content/80" : "text-content/60"}`}>{f.summary}</span>
            </div>
            {f.failure_scenario ? (
              <div className="min-w-0 break-words pl-0.5 text-content/50">{f.failure_scenario}</div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
