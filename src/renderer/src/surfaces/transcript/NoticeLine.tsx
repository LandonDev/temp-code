// A9 (notices): the one line every transcript notice is drawn on.
import { useContext, type ReactNode } from "react";
import { ChevronRight } from "../../chrome/icons";
import { CollapsibleTrigger } from "../../components/ui/collapsible";
import { reveal } from "../../components/ui/reveal";
import { TooltipProvider } from "../../components/ui/tooltip";
import { DISCLOSURE_CHEVRON } from "../../components/ui/disclosure";
import { cn } from "../../lib/cn";
import { STEP_NOTICE, StepRowContext, TABLE_BODY } from "./stepLine";

/**
 * A notice on one line, the action rows' size (13px on 20px in a 28px row): a 14px glyph
 * slot (a StatusMark glyph when a state applies, else a chrome icon), the
 * lead, its details 4px apart in the muted ink (each shrinks and truncates
 * before the lead, a `trailing` status or the chevron does), then actions
 * shown on the line's hover or focus; the glyph sits 8px from the lead, and
 * a trailing status, the chevron and the actions 8px after the last detail. The glyph slot matches the action rows' tool icon,
 * so notice text lines up with them. Wrapping text breaks under the lead,
 * never under the glyph. A line that opens (`fold`, inside a Collapsible)
 * is its own trigger, as an action row is: the whole line, a bare chevron
 * at its end, the lead lifting on hover. `children` is what opens under
 * the line (a log, findings), indented to the lead.
 *
 * Folded into a run as one of its steps (`StepRowContext`), the line reads
 * verb then target like a call: the lead muted whatever `tone` says (a
 * failure is the glyph's to say), the first detail in foreground.
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
  className?: string;
  children?: ReactNode;
  role?: string;
  "aria-label"?: string;
  "data-state"?: string;
}) {
  const shown = details.filter((d) => d != null && d !== false && d !== "");
  const step = useContext(StepRowContext);
  const strong = tone === "strong" && !step;
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
              fold && "group-hover/notice:text-foreground",
              wrap ? "min-w-0 whitespace-pre-wrap break-words" : "shrink-0",
            )}
          >
            {lead}
          </span>
          {shown.map((detail, i) => (
            <span
              key={i}
              className={cn(
                step && i === 0 ? "text-foreground" : "text-muted-foreground",
                wrap ? "" : "min-w-0 truncate",
              )}
            >
              {detail}
            </span>
          ))}
          {trailing ? <span className="ms-1 flex shrink-0 items-center">{trailing}</span> : null}
          {fold ? (
            <ChevronRight
              aria-hidden
              className={cn(
                "ms-1 size-3 shrink-0 text-muted-foreground group-hover/notice:text-foreground",
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
      {/* What opens under the line is no step: its own lines read as notices. */}
      {children ? (
        <div className={cn("min-w-0 pl-5.5", TABLE_BODY)}>
          <StepRowContext.Provider value={false}>{children}</StepRowContext.Provider>
        </div>
      ) : null}
    </div>
  );
}
