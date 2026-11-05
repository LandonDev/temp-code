// A9 (notices): the one line every transcript notice is drawn on.
import { Fragment, useContext, type ReactNode } from "react";
import { ChevronRight } from "../../chrome/icons";
import { CollapsibleContent, CollapsibleTrigger } from "../../components/ui/collapsible";
import { reveal } from "../../components/ui/reveal";
import { TooltipProvider } from "../../components/ui/tooltip";
import { DISCLOSURE_CHEVRON } from "../../components/ui/disclosure";
import { cn } from "../../lib/cn";
import { STEP_NOTICE, StepRowContext, TABLE_BODY } from "./stepLine";

/**
 * A notice on one line, the action rows' size (13px on 20px in a 28px row): a 14px glyph
 * slot (a StatusMark glyph when a state applies, else a chrome icon), the
 * lead (medium weight when details follow it), its details 4px after it as one muted comma run
 * ("master, release-277") that shrinks and truncates, with one ellipsis,
 * before the lead, a `trailing` status or the chevron does, then actions
 * shown on the line's hover or focus; the glyph sits 8px from the lead, and
 * a trailing status, the chevron and the actions 8px after the last detail. The glyph slot matches the action rows' tool icon,
 * so notice text lines up with them. Wrapping text breaks under the lead,
 * never under the glyph. A line that opens (`fold`, inside a Collapsible)
 * is its own trigger, as an action row is: the whole line, a bare chevron
 * at its end, the lead lifting on hover. `children` is what opens under
 * the line (a log, findings), indented to the lead; with a `fold`, inside
 * the fold's content.
 *
 * Folded into a run as one of its steps (`StepRowContext`), the line reads
 * verb then target like a call: the lead muted and regular whatever `tone`
 * says (a failure is the glyph's to say), the first detail its own span in
 * foreground, the rest the muted comma run.
 */
export function NoticeLine({
  glyph,
  lead,
  details = [],
  fold,
  trailing,
  actions,
  tone = "muted",
  wrap = false,
  shrinkLead = false,
  className,
  children,
  ...rest
}: {
  glyph?: ReactNode;
  lead: ReactNode;
  details?: ReactNode[];
  /** The line opens what it holds: its open state and the trigger's name. */
  fold?: { open: boolean; label: string };
  /** Shown after the details and never squeezed (a status). */
  trailing?: ReactNode;
  actions?: ReactNode;
  /** `strong` sets the lead in the foreground (a red run, a live hold). */
  tone?: "muted" | "strong";
  /** Let the lead wrap instead of truncating (plain system text). */
  wrap?: boolean;
  /** The lead carries its own details (they morph with it): it takes the
   *  line's width and shrinks, so their run truncates inside it. */
  shrinkLead?: boolean;
  className?: string;
  children?: ReactNode;
  role?: string;
  "aria-label"?: string;
  "data-state"?: string;
}) {
  const shown = details.filter((d) => d != null && d !== false && d !== "");
  const step = useContext(StepRowContext);
  const strong = tone === "strong" && !step;
  // A step reads verb then target: its first detail stands on its own.
  const target = step ? shown[0] : undefined;
  const run = step ? shown.slice(1) : shown;
  // What opens under the line is no step: its own lines read as notices.
  const body = children ? (
    <div data-slot="notice-body" className={cn("min-w-0 pl-5.5", TABLE_BODY)}>
      <StepRowContext.Provider value={false}>{children}</StepRowContext.Provider>
    </div>
  ) : null;
  return (
    <div data-slot="notice-line" className={cn("group/notice flex min-w-0 flex-col font-sans text-[13px] leading-5", className)} {...rest}>
      <div className={cn("relative flex min-w-0 items-start gap-2", STEP_NOTICE)}>
        {fold ? (
          <CollapsibleTrigger
            aria-label={fold.label}
            className="absolute inset-0 cursor-default rounded-md"
          />
        ) : null}
        <span className="flex h-5 w-3.5 shrink-0 items-center justify-center text-muted-foreground [&>svg]:size-3.5">
          {glyph}
        </span>
        <div className={cn("flex min-w-0 flex-1 gap-x-1 leading-5", fold && "pointer-events-none", wrap ? "flex-wrap" : "items-center")}>
          <span
            className={cn(
              strong ? "text-foreground" : "text-muted-foreground",
              // The weight parts a lead from its details; a lone lead or a sentence stays regular.
              !step && run.length > 0 && "font-medium",
              fold && NOTICE_LIFT,
              wrap ? "min-w-0 whitespace-pre-wrap break-words" : shrinkLead ? "flex min-w-0" : "shrink-0",
            )}
          >
            {lead}
          </span>
          {target != null ? (
            <span className={cn("text-foreground", wrap ? "" : "min-w-0 truncate")}>{target}</span>
          ) : null}
          {run.length ? <DetailRun items={run} wrap={wrap} /> : null}
          {trailing ? <span className="ms-1 flex shrink-0 items-center">{trailing}</span> : null}
          {fold ? (
            <ChevronRight
              aria-hidden
              className={cn(
                "ms-1 size-3 shrink-0 text-muted-foreground",
                NOTICE_LIFT,
                DISCLOSURE_CHEVRON,
                fold.open && "rotate-90",
              )}
            />
          ) : null}
          {actions ? (
            <span
              data-slot="notice-actions"
              className={`pointer-events-auto relative ms-1 flex shrink-0 items-center ${reveal("notice")} has-aria-expanded:opacity-100`}
            >
              <TooltipProvider>{actions}</TooltipProvider>
            </span>
          ) : null}
        </div>
      </div>
      {body && fold ? <CollapsibleContent>{body}</CollapsibleContent> : body}
    </div>
  );
}


/** A line that opens lifts its lead and chevron at once, on hover and on its trigger's keyboard focus alike. */
const NOTICE_LIFT = "group-hover/notice:text-foreground group-has-focus-visible/notice:text-foreground";

/**
 * A notice's details as one muted comma run that truncates with one
 * ellipsis. Every detail after the first is one unbreakable box carrying the
 * comma before it, so a cut drops the whole detail with its comma and the
 * ellipsis never lands on punctuation ("no blocking findings…", never
 * "no blocking findings, a…"); the first is cut mid-phrase only when it alone
 * is too wide.
 */
export function DetailRun({ items, wrap = false, className }: { items: ReactNode[]; wrap?: boolean; className?: string }) {
  return (
    <span data-slot="notice-details" className={cn("text-muted-foreground", wrap ? "" : "min-w-0 truncate", className)}>
      {items.map((detail, i) =>
        i === 0 || wrap ? (
          <Fragment key={i}>
            {i > 0 ? joiner(items[i - 1]) : null}
            {detail}
          </Fragment>
        ) : (
          <span key={i} data-slot="notice-detail" className="inline-block whitespace-pre">
            {joiner(items[i - 1])}
            {detail}
          </span>
        ),
      )}
    </span>
  );
}

/** A comma between details, unless the one before already ends its phrase ("Backfill the old rows? Yes"). */
function joiner(before: ReactNode): string {
  return typeof before === "string" && /[?:]$/.test(before) ? " " : ", ";
}
