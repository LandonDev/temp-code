import type { HTMLAttributes, MouseEvent, ReactNode, Ref } from "react";
import { Button } from "../components/ui/button";
import { DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/cn";
import type { IntentProps } from "../lib/lazyChunk";
import type { IconComponent } from "./icons";

/** The one action a row shows on hover or focus, in the trailing slot's place. */
export type RailRowAction = {
  label: string;
  icon: IconComponent;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  /** It opens a menu: `aria-haspopup`, and the expanded state while open. */
  menu?: boolean;
  expanded?: boolean;
};

type Props = {
  /** A 16px icon, or a `glyph` node (a workspace's logo or mascot). */
  icon?: IconComponent;
  glyph?: ReactNode;
  label: ReactNode;
  ariaLabel?: string;
  selected?: boolean;
  /** Medium foreground at rest: something new waits behind the row. */
  emphasis?: boolean;
  /** One node at the row's end: a mark, a percentage, dots. */
  trailing?: ReactNode;
  /** The trailing node is a control of its own (a status chip that opens
   *  a popover): it sits beside the row's button instead of inside it. */
  trailingInteractive?: boolean;
  hoverAction?: RailRowAction;
  /** A label on hover (a shortcut as `Kbd`); never a `title=`. */
  tooltip?: ReactNode;
  /** The row is the trigger of the `DropdownMenu` around it. */
  menuTrigger?: boolean;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Hover or focus warms the chunk the click opens (lib/lazyChunk.tsx). */
  intent?: IntentProps;
  /** The glyph's colour, when the row is a call to action (`text-accent`). */
  glyphClassName?: string;
  /** The wrapper: sortable pointer handlers, a context menu, data attributes;
   *  `children` draw over the row (a drag's drop marker). */
  rowRef?: Ref<HTMLDivElement>;
  className?: string;
} & Omit<HTMLAttributes<HTMLDivElement>, "onClick" | "className">;

const TRAILING =
  "flex shrink-0 items-center justify-end gap-1 text-[12px] tabular-nums text-muted-foreground";
/** With a hover action, the trailing slot reserves its place and fades. */
const YIELDS =
  "min-w-5 transition-opacity duration-(--dur-fast) ease-(--ease-out) group-focus-within/row:opacity-0 group-hover/row:opacity-0 motion-reduce:transition-none";

/**
 * A rail row: 36px, a 16px glyph, a 13px label, at most one trailing mark
 * and one hover action. Muted at rest, foreground on hover, focus and
 * selection; selection is a `muted` fill (`aria-current`), never a bar,
 * border or shadow. Rows never animate in or out; press is the Button's.
 */
export function RailRow({
  icon: Icon,
  glyph,
  label,
  ariaLabel,
  selected = false,
  emphasis = false,
  trailing,
  trailingInteractive = false,
  hoverAction,
  tooltip,
  menuTrigger = false,
  onClick,
  intent,
  glyphClassName,
  rowRef,
  className,
  children,
  ...wrapper
}: Props) {
  const hasTrailing = trailing != null || !!hoverAction;
  // A control in the trailing slot (a status chip) keeps its place and the
  // hover action follows it; a plain mark yields its place to the action.
  const trailingSlot = hasTrailing ? (
    <span
      data-rail-trailing
      className={cn(TRAILING, hoverAction && !trailingInteractive && YIELDS, trailingInteractive && (hoverAction ? "pr-1" : "pr-3"))}
    >
      {trailing}
      {trailingInteractive && hoverAction ? <HoverAction action={hoverAction} inline /> : null}
    </span>
  ) : null;
  const rowProps = {
    variant: "ghost" as const,
    ...intent,
    onClick,
    "aria-label": ariaLabel,
    "aria-current": selected ? ("true" as const) : undefined,
    className: cn(
      "h-9 min-w-0 flex-1 justify-start gap-2 rounded-md px-3 text-[13px] font-normal text-inherit",
      "hover:bg-transparent active:bg-transparent aria-expanded:bg-transparent",
      emphasis && "font-medium",
      trailingInteractive && "pr-2",
    ),
  };
  const content = (
    <>
      <span aria-hidden className={cn("grid size-4 shrink-0 place-items-center", glyphClassName)}>
        {glyph ?? (Icon ? <Icon className="size-4" strokeWidth={1.5} /> : null)}
      </span>
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {trailingInteractive ? null : trailingSlot}
    </>
  );
  return (
    <div
      ref={rowRef}
      data-rail-row
      className={cn(
        "group/row relative flex items-center rounded-md text-muted-foreground",
        "hover:bg-foreground/5 hover:text-foreground focus-within:text-foreground",
        "has-[[aria-expanded=true]]:bg-muted has-[[aria-expanded=true]]:text-foreground",
        selected && "bg-muted text-foreground hover:bg-muted",
        emphasis && "text-foreground",
        className,
      )}
      {...wrapper}
    >
      {menuTrigger ? (
        <DropdownMenuTrigger render={<Button {...rowProps} />}>{content}</DropdownMenuTrigger>
      ) : tooltip ? (
        <Tooltip>
          <TooltipTrigger render={<Button {...rowProps} />}>{content}</TooltipTrigger>
          <TooltipContent side="right">{tooltip}</TooltipContent>
        </Tooltip>
      ) : (
        <Button {...rowProps}>{content}</Button>
      )}
      {trailingInteractive ? trailingSlot : null}
      {hoverAction && !trailingInteractive ? <HoverAction action={hoverAction} /> : null}
      {children}
    </div>
  );
}

function HoverAction({ action, inline = false }: { action: RailRowAction; inline?: boolean }) {
  const { icon: Icon } = action;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
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
              !inline && "absolute top-1/2 right-1 -translate-y-1/2",
              "text-muted-foreground hover:text-foreground",
              "pointer-events-none opacity-0 transition-opacity duration-(--dur-fast) ease-(--ease-out) motion-reduce:transition-none",
              "group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100",
              action.expanded && "pointer-events-auto opacity-100",
            )}
          />
        }
      >
        <Icon className="size-4" strokeWidth={1.5} />
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
      <span id={id} data-rail-heading className="min-w-0 flex-1 truncate text-[12px] font-medium text-muted-foreground">
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
            <Icon className="size-3.5" strokeWidth={1.5} />
          </TooltipTrigger>
          <TooltipContent side="right">{action.label}</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}
