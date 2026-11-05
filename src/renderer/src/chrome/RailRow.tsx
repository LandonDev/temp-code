import type { HTMLAttributes, MouseEvent, ReactNode, Ref } from "react";
import { Button } from "../components/ui/button";
import { DropdownMenuTrigger } from "../components/ui/lazy-menus";
import { useTruncated } from "../components/tip";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "../components/ui/tooltip";
import { cn } from "../lib/cn";
import type { IntentProps } from "../lib/lazyChunk";
import type { IconComponent } from "./icons";

/** An action a row shows on hover or focus, at its end. */
export type RailRowAction = {
  label: string;
  icon: IconComponent;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  /** It opens a menu: `aria-haspopup`, and the expanded state while open. */
  menu?: boolean;
  expanded?: boolean;
};

type Props = {
  /** A 16px icon, or a `glyph` node (a spinner). A row with neither has no
   *  glyph slot: its label starts at the row's 12px inset. */
  icon?: IconComponent;
  glyph?: ReactNode;
  label: ReactNode;
  ariaLabel?: string;
  selected?: boolean;
  /** Medium weight at rest: something new waits behind the row. */
  emphasis?: boolean;
  /** `group` is a container (a workspace): its own resting, hovered and
   *  selected fills (`sidebar-group`), the label foreground at every state. */
  surface?: "item" | "group";
  /** One node at the row's end: a mark, a percentage, dots. */
  trailing?: ReactNode;
  /** The trailing node is a control of its own (a status glyph that opens
   *  a popover): it sits beside the row's button instead of inside it. */
  trailingInteractive?: boolean;
  /** At most two actions, in order at the row's end on hover and focus;
   *  their presses never reach the row. */
  hoverActions?: readonly RailRowAction[];
  /** A label on hover (a shortcut as `Kbd`); never a `title=`. Without
   *  one, a string label that is cut shows whole on hover. */
  tooltip?: ReactNode;
  /** The row is the trigger of the `DropdownMenu` around it. */
  menuTrigger?: boolean;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Hover or focus warms the chunk the click opens (lib/lazyChunk.tsx). */
  intent?: IntentProps;
  /** The glyph's colour, when the row is a call to action (`text-accent`). */
  glyphClassName?: string;
  /** The row's button is disabled (an action already under way). */
  disabled?: boolean;
  /** Set: the row is a switch (`role="switch"`), on while true; its
   *  trailing node draws the track (chrome/AwayRow.tsx). */
  checked?: boolean;
  /** The wrapper: sortable pointer handlers, a context menu, data attributes;
   *  `children` draw over the row (a drag's drop marker). */
  rowRef?: Ref<HTMLDivElement>;
  className?: string;
} & Omit<HTMLAttributes<HTMLDivElement>, "onClick" | "className">;

const TRAILING =
  "flex shrink-0 items-center justify-end gap-1 text-xs tabular-nums text-muted-foreground";
/** With hover actions over it, the trailing slot reserves their place and
 *  fades: one 24px action, or two. */
const YIELDS =
  "transition-opacity duration-(--dur-fast) ease-(--ease-out) group-focus-within/row:opacity-0 group-hover/row:opacity-0 group-hover/row:delay-(--delay-hover) group-focus-within/row:delay-(--dur-instant) motion-reduce:transition-opacity";
const RESERVE = ["", "min-w-5", "min-w-11"] as const;
/** A plain mark beside an interactive trailing control that gives its place
 *  to the hover actions (the selected workspace's diff). Spread on the mark. */
export const RAIL_YIELD = {
  "data-rail-yield": "",
  className: "group-focus-within/row:hidden group-hover/row:hidden",
} as const;

/**
 * A rail row: 28px, a 16px glyph when it has one, a 13px label, at most one
 * trailing node and two hover actions. An item is muted at rest, foreground
 * on hover, focus and selection; selection is a `muted` fill
 * (`aria-current`), never a bar, border or shadow. A group (`surface`)
 * sits on its own fill. Rows never animate in or out, and the fill never
 * transitions; press is the Button's.
 */
export function RailRow({
  icon: Icon,
  glyph,
  label,
  ariaLabel,
  selected = false,
  emphasis = false,
  surface = "item",
  trailing,
  trailingInteractive = false,
  hoverActions = [],
  tooltip,
  menuTrigger = false,
  onClick,
  intent,
  glyphClassName,
  disabled,
  checked,
  rowRef,
  className,
  children,
  ...wrapper
}: Props) {
  // A string label the row cuts is its own tooltip, only while it is cut.
  const text = typeof label === "string" ? label : "";
  const { ref: labelRef, cut } = useTruncated(text);
  const tip = tooltip ?? (cut ? text : null);
  const actions = hoverActions.slice(0, 2);
  const group = surface === "group";
  const hasTrailing = trailing != null || actions.length > 0;
  // A control in the trailing slot (a status glyph) keeps its place and the
  // hover actions follow it; a plain mark yields its place to them.
  const trailingSlot = hasTrailing ? (
    <span
      data-rail-trailing
      className={cn(
        TRAILING,
        actions.length > 0 && !trailingInteractive && [YIELDS, RESERVE[actions.length]],
        trailingInteractive && "pr-0.5",
      )}
    >
      {trailing}
      {trailingInteractive ? actions.map((action) => <HoverAction key={action.label} action={action} inline />) : null}
    </span>
  ) : null;
  const hasGlyph = glyph != null || !!Icon;
  const rowProps = {
    variant: "ghost" as const,
    ...intent,
    onClick,
    disabled,
    "aria-label": ariaLabel,
    "aria-current": selected ? ("true" as const) : undefined,
    ...(checked === undefined ? {} : { role: "switch", "aria-checked": checked }),
    className: cn(
      "h-7 min-w-0 flex-1 justify-start gap-2 rounded-md px-3 text-[13px] font-normal text-inherit",
      "hover:bg-transparent active:bg-transparent aria-expanded:bg-transparent",
      emphasis && "font-medium",
      trailingInteractive && "pr-1",
    ),
  };
  const content = (
    <>
      {hasGlyph ? (
        <span aria-hidden className={cn("grid size-4 shrink-0 place-items-center", glyphClassName)}>
          {glyph ?? (Icon ? <Icon className="size-4" /> : null)}
        </span>
      ) : null}
      <span ref={text ? labelRef : undefined} className="min-w-12 flex-1 truncate text-left">
        {label}
      </span>
      {trailingInteractive ? null : trailingSlot}
    </>
  );
  return (
    <div
      ref={rowRef}
      data-rail-row
      data-surface={group ? "group" : undefined}
      className={cn(
        "group/row relative flex items-center rounded-md",
        group
          ? [
              "bg-sidebar-group text-foreground hover:bg-sidebar-group-hover has-[>[data-slot=button]:active]:bg-sidebar-group-selected",
              "has-[[aria-expanded=true]]:bg-sidebar-group-selected",
              selected && "bg-sidebar-group-selected hover:bg-sidebar-group-selected",
            ]
          : [
              "text-muted-foreground hover:bg-foreground/5 hover:text-foreground focus-within:text-foreground has-[>[data-slot=button]:active]:bg-foreground/12",
              "has-[[aria-expanded=true]]:bg-muted has-[[aria-expanded=true]]:text-foreground",
              selected && "bg-muted text-foreground hover:bg-muted",
              emphasis && "text-foreground",
            ],
        className,
      )}
      {...wrapper}
    >
      {menuTrigger ? (
        <DropdownMenuTrigger render={<Button {...rowProps} />}>{content}</DropdownMenuTrigger>
      ) : tooltip || text ? (
        // One trigger whether or not the label is cut: a resize never remounts the row.
        <Tooltip disabled={!tip}>
          <TooltipTrigger render={<Button {...rowProps} />}>{content}</TooltipTrigger>
          <TooltipContent side="right">{tip}</TooltipContent>
        </Tooltip>
      ) : (
        <Button {...rowProps}>{content}</Button>
      )}
      {trailingInteractive ? trailingSlot : null}
      {actions.length > 0 && !trailingInteractive ? (
        <span data-rail-actions className="pointer-events-none absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5">
          <TooltipProvider>
            {actions.map((action) => (
              <HoverAction key={action.label} action={action} />
            ))}
          </TooltipProvider>
        </span>
      ) : null}
      {children}
    </div>
  );
}

/** A 24px icon Button with its Tooltip, shown on the row's hover and focus:
 *  over the row's end (fading in over the trailing mark), or inline after an
 *  interactive trailing node (taking its place in the line only then). */
function HoverAction({ action, inline = false }: { action: RailRowAction; inline?: boolean }) {
  const { icon: Icon } = action;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            data-no-drag
            aria-label={action.label}
            aria-haspopup={action.menu ? "menu" : undefined}
            aria-expanded={action.menu ? !!action.expanded : undefined}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              action.onClick(event);
            }}
            className={cn(
              "text-muted-foreground hover:text-foreground",
              inline
                ? ["hidden group-focus-within/row:inline-flex group-hover/row:inline-flex", action.expanded && "inline-flex"]
                : [
                    "pointer-events-none opacity-0 transition-opacity duration-(--dur-fast) ease-(--ease-out) motion-reduce:transition-opacity",
                    // A pointer sweeping down the rail does not flash every row's actions: hover waits, focus does not.
                    "group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100 group-hover/row:delay-(--delay-hover) group-focus-within/row:delay-(--dur-instant) motion-reduce:transition-opacity",
                    action.expanded && "pointer-events-auto opacity-100 delay-(--dur-instant)",
                  ],
            )}
          />
        }
      >
        <Icon className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent side="right">{action.label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * A group's name over its rows: 28px, 12px medium muted, sentence case, on
 * the rows' glyph column. `action` is one always-visible icon button at its
 * end (Add workspace).
 */
export function RailHeading({
  id,
  children,
  action,
}: {
  id?: string;
  children: string;
  action?: { label: string; icon: IconComponent; onClick: () => void };
}) {
  const Icon = action?.icon;
  return (
    <div className="flex h-7 shrink-0 items-center gap-1 pr-1 pl-3">
      <span id={id} data-rail-heading className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
        {children}
      </span>
      {action && Icon ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={action.label}
                onClick={action.onClick}
                className="text-muted-foreground hover:text-foreground"
              />
            }
          >
            <Icon className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent side="right">{action.label}</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}
