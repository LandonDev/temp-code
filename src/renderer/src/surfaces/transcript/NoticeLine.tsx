// A9 (notices): the one line every transcript notice is drawn on.
import type { ReactNode } from "react";
import { ChevronRight } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import { CollapsibleTrigger } from "../../components/ui/collapsible";
import { cn } from "../../lib/cn";

/**
 * A notice on one line: a 14px glyph slot (a StatusMark glyph when a state
 * applies, else a chrome icon), the lead, its details 8px apart in the
 * muted ink, then an optional trailing control (a caret) and actions. The
 * glyph slot matches the action rows' tool icon, so notice text lines up
 * with them. Wrapping text breaks under the lead, never under the glyph.
 * `actions` show on the line's hover or focus only. `children` is what
 * opens under the line (a log, findings), indented to the lead.
 */
export function NoticeLine({
  glyph,
  lead,
  details = [],
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
  return (
    <div data-slot="notice-line" className={cn("group/notice flex min-w-0 flex-col font-sans text-[13px]", className)} {...rest}>
      <div className="flex min-h-7 min-w-0 items-start gap-2 py-1">
        <span className="flex h-5 w-3.5 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-3.5">
          {glyph}
        </span>
        <div className={cn("flex min-w-0 flex-1 gap-x-2 leading-5", wrap ? "flex-wrap" : "items-center")}>
          <span
            className={cn(
              tone === "strong" ? "text-foreground" : "text-muted-foreground",
              wrap ? "min-w-0 whitespace-pre-wrap break-words" : "shrink-0",
            )}
          >
            {lead}
          </span>
          {shown.map((detail, i) => (
            <span key={i} className={cn("text-muted-foreground", wrap ? "" : i === shown.length - 1 ? "min-w-0 truncate" : "shrink-0")}>
              {detail}
            </span>
          ))}
          {trailing ? <span className="flex shrink-0 items-center">{trailing}</span> : null}
          {actions ? (
            <span
              data-slot="notice-actions"
              className="flex shrink-0 items-center opacity-0 transition-opacity duration-(--dur-fast) ease-(--ease-out) focus-within:opacity-100 group-hover/notice:opacity-100 motion-reduce:transition-none"
            >
              {actions}
            </span>
          ) : null}
        </div>
      </div>
      {children ? <div className="min-w-0 pl-5.5">{children}</div> : null}
    </div>
  );
}

/** The caret that opens a notice's body: put the line in a Collapsible and
 *  this in its `trailing` slot. */
export function NoticeCaret({ open, label }: { open: boolean; label: string }) {
  return (
    <CollapsibleTrigger
      render={<Button variant="ghost" size="icon-xs" aria-label={label} className="-my-0.5 text-muted-foreground hover:text-foreground aria-expanded:bg-transparent aria-expanded:hover:bg-foreground/7" />}
    >
      <ChevronRight
        className={cn(
          "size-3 transition-transform duration-(--dur-fast) ease-(--ease-out) motion-reduce:transition-none",
          open && "rotate-90",
        )}
      />
    </CollapsibleTrigger>
  );
}
