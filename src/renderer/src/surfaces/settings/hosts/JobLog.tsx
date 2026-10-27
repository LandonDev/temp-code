import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../../components/ui/collapsible";
import { Spinner } from "../../../components/ui/spinner";
import { ChevronRight } from "../../../chrome/icons";
import { errorText } from "../../../chrome/ConfirmDialog";
import { useEnvironmentStatus } from "../../../lib/connection";
import { hostJobCard, type HostJobCard } from "../../../lib/hostJobCard";
import { dismissJob, stopPublish, useDeployStatuses, useHostJob } from "../../../lib/hostJobs";

/** A log is open while its job runs and after a failure; a pass folds it to its one line. */
export const openByDefault = (card: Pick<HostJobCard, "phase" | "ending">): boolean => card.phase !== "done" || card.ending?.failed === true;

/**
 * A deploy's or a publish's log under its row: one line that says what runs
 * (or how it ended) and folds open onto the console, the last 40 lines,
 * following the bottom unless the reader scrolled up. Stop for a publish
 * that can be stopped, Dismiss once done.
 */
export function JobLog({ environmentId, job, hostName }: { environmentId: string; job: "deploy" | "publish"; hostName: string }) {
  const entry = useHostJob(environmentId, job);
  const status = useEnvironmentStatus(environmentId);
  const deployed = useDeployStatuses()[environmentId]?.version ?? null;
  const [error, setError] = useState<string | null>(null);
  const card = entry
    ? hostJobCard({ job, status: entry.status, text: entry.text, hostName, linkUp: status.transport === "open", deployedVersion: deployed })
    : null;
  const fallback = card ? openByDefault(card) : false;
  const [open, setOpen] = useState(fallback);
  // A job that starts, passes or fails takes its default again; the reader's toggle holds in between.
  const stage = card ? `${card.phase}:${card.ending?.failed ?? ""}` : "";
  useEffect(() => setOpen(fallback), [stage]); // eslint-disable-line react-hooks/exhaustive-deps

  const pre = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  const text = entry?.text ?? "";
  useEffect(() => {
    const el = pre.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [text, open]);

  if (!card || !card.visible) return null;
  const running = card.phase === "pending" || card.phase === "running";
  const ending = card.ending;
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-job-log={job} data-job-phase={card.phase}>
      <div className="flex min-h-7 items-center gap-2">
        <CollapsibleTrigger
          aria-label={card.title}
          className="group/fold flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight className="size-3 shrink-0 text-muted-foreground transition-transform duration-(--dur-fast) group-data-[panel-open]/fold:rotate-90 motion-reduce:transition-none" />
          {running ? <Spinner className="size-3.5 text-muted-foreground" /> : null}
          <span className="shrink-0 font-medium text-foreground">{card.title}</span>
          {running && card.note ? <span className="min-w-0 truncate text-muted-foreground">{card.note}</span> : null}
          {ending ? (
            <span data-job-ending className={`min-w-0 truncate ${ending.failed ? "text-destructive" : "text-muted-foreground"}`}>
              {ending.text}
            </span>
          ) : null}
        </CollapsibleTrigger>
        {card.stoppable ? (
          <Button variant="destructive" size="xs" onClick={() => void stopPublish().catch((e) => setError(errorText(e)))}>
            Stop
          </Button>
        ) : null}
        {!running ? (
          <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => dismissJob(environmentId, job)}>
            Dismiss
          </Button>
        ) : null}
      </div>
      <CollapsibleContent>
        <pre
          ref={pre}
          onScroll={(e) => {
            const el = e.currentTarget;
            follow.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
          }}
          className="mt-1 mb-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 px-3 py-2 font-mono text-[11px] leading-4 text-muted-foreground"
        >
          {card.lines.length ? card.lines.join("\n") : running ? "Waiting for output…" : ""}
        </pre>
      </CollapsibleContent>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </Collapsible>
  );
}
