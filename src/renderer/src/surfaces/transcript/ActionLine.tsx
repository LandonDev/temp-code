// A8 (action rows): the one line every action row draws.
import { cloneElement, type ReactNode } from "react";
import { ChevronRight } from "../../chrome/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { cn } from "../../lib/cn";
import { useCountUp } from "../../motion";

/**
 * `[glyph]  Verb  object  +46 −3  extras  ▸`, 32px tall. The list around
 * the rows gives them their side padding (ActionGroup), so a lone row lines
 * up with the prose. Hover lifts the verb and the caret to foreground, as
 * the group line does. The line's own action (open the
 * body, or open the file) is one button stretched under the content, so the
 * object can be a link of its own and the extras stay real buttons without
 * nesting one button inside another.
 */
export function ActionLine({
  glyph,
  verb,
  object,
  title,
  label,
  onObject,
  objectLabel,
  adds,
  dels,
  ticking = false,
  trailing,
  open,
  onToggle,
  onActivate,
}: {
  glyph: ReactNode;
  verb: string;
  object: string;
  /** The object's full form, shown in a tooltip. */
  title?: string;
  /** The line's accessible name. */
  label: string;
  /** Makes the object a link of its own (open the file, the thread). */
  onObject?: () => void;
  objectLabel?: string;
  adds?: number;
  dels?: number;
  /** The counts tick toward their value while the edit streams. */
  ticking?: boolean;
  /** The row's extras, in order: steps, host, port, reconnect, status. */
  trailing?: ReactNode;
  /** Set when the row opens a body: the caret shows and turns. */
  open?: boolean;
  onToggle?: () => void;
  /** The whole line does one thing (a read opens its file); no caret. */
  onActivate?: () => void;
}) {
  const action = onToggle ?? onActivate;
  const opens = !!onToggle;
  const objectText = object ? <ObjectText object={object} title={title} onObject={onObject} label={objectLabel} onLine={action} /> : null;
  return (
    <div
      className={cn(
        "group/action relative flex h-8 min-w-0 items-center gap-2 font-sans text-sm",
      )}
    >
      {action ? (
        <button
          type="button"
          aria-label={label}
          aria-expanded={opens ? !!open : undefined}
          onClick={action}
          className="absolute inset-0 cursor-default rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      ) : (
        <span className="sr-only">{label}</span>
      )}
      {glyph}
      <span className="pointer-events-none flex min-w-0 flex-1 items-center gap-2">
        {verb ? <span className={cn("shrink-0 text-muted-foreground", action && LIFT)}>{verb}</span> : null}
        {objectText}
        {adds || dels ? <Counts adds={adds ?? 0} dels={dels ?? 0} ticking={ticking} /> : null}
      </span>
      {/* Extras are buttons of their own; a click between them is the line's. */}
      {trailing ? (
        <span className="relative flex shrink-0 items-center gap-2" onClick={action}>
          {trailing}
        </span>
      ) : null}
      {opens ? (
        <ChevronRight
          aria-hidden
          className={cn(
            "pointer-events-none size-3 shrink-0 text-muted-foreground transition-[rotate,color] duration-(--dur-fast) ease-(--ease-out) group-hover/action:text-foreground motion-reduce:transition-none",
            open && "rotate-90",
          )}
          strokeWidth={1.5}
        />
      ) : null}
    </div>
  );
}

/** Hover and keyboard focus on the line lift its muted words. */
const LIFT =
  "transition-[color] duration-(--dur-fast) group-hover/action:text-foreground group-has-focus-visible/action:text-foreground motion-reduce:transition-none";

/** The object in foreground: plain text, or a link; its full form in a tooltip. */
function ObjectText({
  object,
  title,
  onObject,
  label,
  onLine,
}: {
  object: string;
  title?: string;
  onObject?: () => void;
  label?: string;
  /** The line's own action, for a click that lands on the object's text. */
  onLine?: () => void;
}) {
  const tip = title && title !== object ? title : undefined;
  const cls = "min-w-0 truncate text-foreground";
  const link = onObject ? (
    <button
      type="button"
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onObject();
      }}
      className={cn(
        cls,
        "pointer-events-auto relative cursor-default text-left underline-offset-2 outline-none hover:underline focus-visible:underline",
      )}
    />
  ) : null;
  if (!tip) return link ? cloneElement(link, undefined, object) : <span className={cls}>{object}</span>;
  // A plain object takes the hover for its tooltip, so it passes its click on.
  const trigger = link ?? <span className={cn(cls, "pointer-events-auto relative")} onClick={onLine} />;
  return (
    <Tooltip>
      <TooltipTrigger render={trigger}>{object}</TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

/** `+46 −3` in green and red, tabular, ticking while the edit streams. */
function Counts({ adds, dels, ticking }: { adds: number; dels: number; ticking: boolean }) {
  const a = useCountUp(adds, ticking);
  const d = useCountUp(dels, ticking);
  return (
    <span className="flex shrink-0 items-center gap-1 text-[13px] tabular-nums">
      {adds ? <span className="text-success">+{a}</span> : null}
      {dels ? <span className="text-destructive">−{d}</span> : null}
    </span>
  );
}
