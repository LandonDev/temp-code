// A8 (action rows): the one line every action row draws.
import { cloneElement, type ReactNode } from "react";
import { ChevronRight } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { cn } from "../../lib/cn";
import { MorphText, useCountUp } from "../../motion";
import { Counts } from "./Counts";
import { STEP_LINE } from "./stepLine";

/**
 * `[glyph]  Verb  object  +46 −3  extras  ▸` on the step grid (stepLine.ts):
 * 28px tall at 13px, 26px hung in an open group, the caret right after the
 * last thing on the line as on the group line. A slot with nothing to draw
 * takes no room. The list around
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
  tally,
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
  /** A tally in the counts slot, muted (a todo list's `1/3`). */
  tally?: string;
  adds?: number;
  dels?: number;
  /** The counts tick toward their value while the edit streams. */
  ticking?: boolean;
  /** The row's extras, in order: steps, host, port, reconnect, status. */
  trailing?: ReactNode;
  /** Set when the row opens a body: the caret turns. */
  open?: boolean;
  onToggle?: () => void;
  /** The whole line does one thing (a read opens its file); the caret
   *  shows and stays unturned. */
  onActivate?: () => void;
}) {
  const action = onToggle ?? onActivate;
  const opens = !!onToggle;
  const objectText = object ? <ObjectText object={object} title={title} onObject={onObject} label={objectLabel} onLine={action} /> : null;
  return (
    <div
      className={cn("group/action relative", STEP_LINE)}
    >
      {action ? (
        <Button
          variant="ghost"
          aria-label={label}
          aria-expanded={opens ? !!open : undefined}
          onClick={action}
          className="absolute inset-0 h-auto rounded-md hover:bg-transparent active:bg-transparent aria-expanded:bg-transparent"
        />
      ) : (
        <span className="sr-only">{label}</span>
      )}
      {glyph}
      <span className="pointer-events-none flex min-w-0 items-center gap-1">
        {/* Keyed by the word: a change of tense ("Reading" to "Read") morphs in place. */}
        {verb ? (
          <MorphText state={verb} className={cn("shrink-0 text-muted-foreground", action && LIFT)}>
            {verb}
          </MorphText>
        ) : null}
        {objectText}
        {tally ? <span className="shrink-0 text-muted-foreground tabular-nums">{tally}</span> : null}
        {adds || dels ? <TickingCounts adds={adds ?? 0} dels={dels ?? 0} ticking={ticking} /> : null}
      </span>
      {/* Extras are buttons of their own; a click between them is the line's.
          Extras that render nothing leave no slot (`empty:hidden`). */}
      {trailing ? (
        <span className="relative ms-1 flex shrink-0 items-center gap-2 empty:hidden" onClick={action}>
          {trailing}
        </span>
      ) : null}
      {action ? (
        <ChevronRight
          aria-hidden
          className={cn(
            "pointer-events-none ms-1 size-3 shrink-0 text-muted-foreground transition-[rotate,color] duration-(--dur-base) ease-(--ease-out) group-hover/action:text-foreground motion-reduce:transition-none",
            opens && open && "rotate-90",
          )}
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
    <Button
      variant="link"
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onObject();
      }}
      className="pointer-events-auto relative h-auto min-w-0 justify-start px-0 text-[13px] font-normal underline-offset-2 focus-visible:underline"
    />
  ) : null;
  const text = <span className={cls}>{object}</span>;
  if (!tip) return link ? cloneElement(link, undefined, text) : text;
  // A plain object takes the hover for its tooltip, so it passes its click on.
  const trigger = link ?? <span className={cn(cls, "pointer-events-auto relative")} onClick={onLine} />;
  return (
    <Tooltip>
      <TooltipTrigger render={trigger}>{link ? text : object}</TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

/** The edit's counts, ticking toward their value while it streams (A7's Counts draws them). */
function TickingCounts({ adds, dels, ticking }: { adds: number; dels: number; ticking: boolean }) {
  return <Counts added={useCountUp(adds, ticking)} removed={useCountUp(dels, ticking)} />;
}
