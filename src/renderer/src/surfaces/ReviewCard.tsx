import { useContext, useState } from "react";
import type { ReviewFinding } from "@server/shared/review";
import { CircleDashed } from "../chrome/icons";
import { Button } from "../components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { StatusMark } from "../components/ui/status";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import type { Block } from "../lib/session";
import { mergeAnyway } from "../lib/tcserver/commands";
import { modelLabel } from "../lib/threads/agents";
import type { OpenFileFn } from "../lib/search";
import { SelectSessionContext } from "./AgentMarkdown";
import { useOpenAgentDetail } from "./agentDetailContext";
import { NoticeCaret, NoticeLine } from "./transcript/NoticeLine";
import { useTranscriptSession } from "./transcriptSession";

type Review = NonNullable<Block["review"]>;

/**
 * A merge review's outcome (shared/review.ts). A settled outcome is one
 * notice line: who reviewed and what it found, the minor findings behind a
 * caret, the review thread on hover. A live hold is the one card: its
 * blocking findings with the file and line to open, then Merge anyway, the
 * person's override.
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
  const openDetail = useOpenAgentDetail();
  const onSelectSession = useContext(SelectSessionContext);
  const [minorOpen, setMinorOpen] = useState(false);
  if (!review) return null;
  const open = openDetail ?? onSelectSession;
  const label = modelLabel(review.provider, review.model);
  const reviewerId = review.reviewerId;
  const openThread = reviewerId && open ? () => open(reviewerId) : null;

  if (review.outcome === "held" && !review.resolved) {
    return <HeldReview review={review} label={label} openThread={openThread} cwd={cwd} onOpenFile={onOpenFile} />;
  }

  const minor = review.minor.length;
  const glyph =
    review.outcome === "timeout" || review.outcome === "failed" ? <CircleDashed /> : <StatusMark state="done" word={false} />;
  return (
    <Collapsible open={minorOpen} onOpenChange={setMinorOpen}>
      <NoticeLine
        glyph={glyph}
        lead={leadOf(review.outcome, label)}
        details={detailOf(review)}
        trailing={minor ? <NoticeCaret open={minorOpen} label={minorOpen ? "Hide minor findings" : "Show minor findings"} /> : undefined}
        actions={
          openThread ? (
            <Button variant="ghost" size="xs" className="-my-0.5 text-muted-foreground hover:text-foreground" onClick={openThread}>
              Review thread
            </Button>
          ) : undefined
        }
      >
        {minor ? (
          <CollapsibleContent>
            <FindingList findings={review.minor} cwd={cwd} onOpenFile={onOpenFile} />
          </CollapsibleContent>
        ) : null}
      </NoticeLine>
    </Collapsible>
  );
}

/** The live hold: the one review card. */
function HeldReview({
  review,
  label,
  openThread,
  cwd,
  onOpenFile,
}: {
  review: Review;
  label: string;
  openThread: (() => void) | null;
  cwd?: string;
  onOpenFile?: OpenFileFn;
}) {
  const sessionId = useTranscriptSession();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minorOpen, setMinorOpen] = useState(false);
  const blocking = review.blocking.length;
  const minor = review.minor.length;

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
    <div data-slot="review-hold" className="my-2 min-w-0 rounded-lg border border-border bg-card p-3 font-sans text-[13px]">
      <div className="flex min-w-0 items-center gap-2 leading-5">
        <StatusMark state="waiting" word={false} />
        <span className="shrink-0 font-medium text-foreground">Reviewed by {label}</span>
        <span className="shrink-0 text-muted-foreground">{plural(blocking, "blocking finding")}</span>
        <span className="min-w-0 truncate text-muted-foreground">merge held</span>
      </div>
      <FindingList findings={review.blocking} cwd={cwd} onOpenFile={onOpenFile} className="mt-3" strong />
      {minor ? (
        <Collapsible open={minorOpen} onOpenChange={setMinorOpen} className="mt-3">
          <CollapsibleTrigger
            render={<Button variant="ghost" size="xs" className="-ml-2 text-muted-foreground hover:text-foreground" />}
          >
            {plural(minor, "minor finding")}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <FindingList findings={review.minor} cwd={cwd} onOpenFile={onOpenFile} className="pt-2" />
          </CollapsibleContent>
        </Collapsible>
      ) : null}
      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-3">
        <Button size="sm" disabled={pending || !sessionId} onClick={merge}>
          {pending ? "Merging…" : "Merge anyway"}
        </Button>
        {openThread ? (
          <Button variant="ghost" size="sm" onClick={openThread}>
            Review thread
          </Button>
        ) : null}
        {error ? <span className="min-w-0 text-xs text-destructive">{error}</span> : null}
      </div>
    </div>
  );
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function leadOf(outcome: Review["outcome"], label: string): string {
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

/** The settled line's details, each its own part. */
export function detailOf(review: Review): string[] {
  const blocking = review.blocking.length;
  const minor = review.minor.length;
  const minorText = minor ? `${minor} minor` : "";
  const parts = (() => {
    switch (review.outcome) {
      case "pass":
        return ["no blocking findings", minorText];
      case "held":
        return [plural(blocking, "blocking finding"), minorText, review.resolved ? "merged anyway" : "merge held"];
      case "timeout":
        return [`after ${review.minutes ?? "?"} min`, "merged without it"];
      case "failed":
        return [review.reason ?? "", "merged without it"];
      case "merged-anyway":
        return [`${plural(blocking, "blocking finding")} overridden`];
      case "skipped":
        return [review.reason ?? ""];
    }
  })();
  return parts.filter(Boolean);
}

/** The findings as rows: the place to open, the claim, the failure. */
function FindingList({
  findings,
  cwd,
  onOpenFile,
  className,
  strong = false,
}: {
  findings: ReviewFinding[];
  cwd?: string;
  onOpenFile?: OpenFileFn;
  className?: string;
  strong?: boolean;
}) {
  return (
    <ol className={`flex min-w-0 flex-col gap-3 ${className ?? ""}`}>
      {findings.map((f, i) => {
        const where = `${f.file}${f.line ? `:${f.line}` : ""}`;
        const path = cwd && !f.file.startsWith("/") ? `${cwd.replace(/\/$/, "")}/${f.file}` : f.file;
        return (
          <li key={`${where}:${i}`} className="flex min-w-0 flex-col items-start">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={!onOpenFile}
                    className="-ml-2 h-5 max-w-full font-mono text-xs font-normal text-muted-foreground hover:text-foreground"
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpenFile?.(path, f.line ? { line: f.line } : undefined);
                    }}
                  />
                }
              >
                <span className="truncate">{where}</span>
              </TooltipTrigger>
              <TooltipContent>{path}</TooltipContent>
            </Tooltip>
            <span className={`min-w-0 break-words text-[13px] ${strong ? "text-foreground" : "text-muted-foreground"}`}>
              {f.summary}
              {f.verdict === "PLAUSIBLE" ? <span className="ml-2 text-xs text-muted-foreground">plausible</span> : null}
            </span>
            {f.failure_scenario ? (
              <span className="mt-0.5 min-w-0 break-words text-xs text-muted-foreground">{f.failure_scenario}</span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
