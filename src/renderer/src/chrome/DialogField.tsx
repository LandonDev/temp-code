import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@renderer/components/ui/item";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { cn } from "../lib/cn";

type Control = ReactElement<{ id?: string; "aria-describedby"?: string; "aria-labelledby"?: string }>;

/**
 * A labelled field in a dialog or sheet: the 12px muted label, 4px, the
 * control, and an optional hint 2px under it. The label and hint are wired
 * to the control (`id`, `aria-describedby`); `aside` sits at the label
 * line's end (a word count, a link).
 */
export function Field({
  label,
  hint,
  aside,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  aside?: ReactNode;
  className?: string;
  children: Control;
}) {
  const auto = useId();
  const id = isValidElement(children) ? (children.props.id ?? auto) : auto;
  const hintId = `${id}-hint`;
  return (
    <div data-slot="dialog-field" className={cn("flex min-w-0 flex-col gap-1", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
          {label}
        </label>
        {aside}
      </div>
      {cloneElement(children, { id, "aria-describedby": hint ? hintId : children.props["aria-describedby"] })}
      {hint ? (
        <p id={hintId} className="-mt-0.5 text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A choice in a dialog: the label at the row's start, the control (a
 * ToggleGroup, a Select, a Switch) at its end. Rows of one group sit
 * against each other; groups are 16px apart.
 */
export function FieldRow({
  label,
  description,
  className,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  className?: string;
  children: Control;
}) {
  const id = useId();
  return (
    <Item size="sm" data-slot="dialog-field-row" className={cn("px-0", className)}>
      <ItemContent className="min-w-0">
        <ItemTitle id={id}>{label}</ItemTitle>
        {description ? <ItemDescription>{description}</ItemDescription> : null}
      </ItemContent>
      <ItemActions className="shrink-0">{cloneElement(children, { "aria-labelledby": children.props["aria-labelledby"] ?? id })}</ItemActions>
    </Item>
  );
}

/** A label on hover for one control (the `title=` replacement). */
export function Tip({ label, side, children }: { label: ReactNode; side?: "top" | "bottom" | "left" | "right"; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}
