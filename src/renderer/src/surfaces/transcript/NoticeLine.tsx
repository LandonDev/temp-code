// A9 (notices): the one line every transcript notice is drawn on.
import type { ReactNode } from "react";
import { ChevronRight } from "../../chrome/icons";
import { CollapsibleTrigger } from "../../components/ui/collapsible";
import { cn } from "../../lib/cn";

/**
 * A notice on one line, the action rows' size (14px on 32px): a 14px glyph
 * slot (a StatusMark glyph when a state applies, else a chrome icon), the
 * lead, its details 8px apart in the muted ink, then actions shown on the
 * line's hover or focus. The glyph slot matches the action rows' tool icon,
 * so notice text lines up with them. Wrapping text breaks under the lead,
 * never under the glyph. A line that opens (`fold`, inside a Collapsible)
 * is its own trigger, as an action row is: the whole line, a bare chevron
 * at its end, the lead lifting on hover. `children` is what opens under
 * the line (a log, findings), indented to the lead.
 */
export function NoticeLine({
  glyph,
  lead,
  details = [],
  fold,
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
    <div data-slot="notice-line" className={cn("group/notice flex min-w-0 flex-col font-sans text-sm", className)} {...rest}>
      <div className="relative flex min-h-8 min-w-0 items-start gap-2 py-1.5">
        {fold ? (
          <CollapsibleTrigger
            aria-label={fold.label}
            className="absolute inset-0 cursor-default rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        ) : null}
        <span className="flex h-5 w-3.5 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-3.5">
          {glyph}
        </span>
        <div className={cn("flex min-w-0 flex-1 gap-x-2 leading-5", fold && "pointer-events-none", wrap ? "flex-wrap" : "items-center")}>
          <span
            className={cn(
              tone === "strong" ? "text-foreground" : "text-muted-foreground",
              fold && "transition-colors duration-(--dur-fast) ease-(--ease-out) group-hover/notice:text-foreground motion-reduce:transition-none",
              wrap ? "min-w-0 whitespace-pre-wrap break-words" : "shrink-0",
            )}
          >
            {lead}
          </span>
          {shown.map((detail, i) => (
            <span
              key={i}
              className={cn(
                "text-muted-foreground",
                wrap ? "" : i === shown.length - 1 ? "min-w-0 truncate" : "shrink-0",
              )}
            >
              {detail}
            </span>
          ))}
          {fold ? (
            <ChevronRight
              aria-hidden
              strokeWidth={1.5}
              className={cn(
                "size-3 shrink-0 text-muted-foreground transition-[rotate,color] duration-(--dur-fast) ease-(--ease-out) group-hover/notice:text-foreground motion-reduce:transition-none",
                fold.open && "rotate-90",
              )}
            />
          ) : null}
          {actions ? (
            <span
              data-slot="notice-actions"
              className="pointer-events-auto relative flex shrink-0 items-center opacity-0 transition-opacity duration-(--dur-fast) ease-(--ease-out) focus-within:opacity-100 group-hover/notice:opacity-100 motion-reduce:transition-none"
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
