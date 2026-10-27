import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@renderer/components/ui/item";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { cn } from "../lib/cn";

type Control = ReactElement<{ id?: string; "aria-describedby"?: string; "aria-labelledby"?: string; "aria-invalid"?: boolean }>;

/**
 * A labelled field in a dialog or sheet: the 12px muted label, 4px, the
 * control, and an optional hint 2px under it; an `error` takes the hint's
 * place in red and marks the control invalid. The label and the line under
 * it are wired to the control (`id`, `aria-describedby`); `aside` sits at
 * the label line's end (a word count, a link).
 */
export function Field({
  label,
  hint,
  error,
  aside,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  aside?: ReactNode;
  className?: string;
  children: Control;
}) {
  const auto = useId();
  const id = isValidElement(children) ? (children.props.id ?? auto) : auto;
  const hintId = `${id}-hint`;
  const line = error || hint;
  return (
    <div data-slot="dialog-field" className={cn("flex min-w-0 flex-col gap-1", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
          {label}
        </label>
        {aside}
      </div>
      {cloneElement(children, {
        id,
        "aria-describedby": line ? hintId : children.props["aria-describedby"],
        ...(error ? { "aria-invalid": true } : {}),
      })}
      {line ? (
        <p id={hintId} className={cn("-mt-0.5 text-xs", error ? "text-destructive" : "text-muted-foreground")}>
          {line}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A choice in a dialog: the label at the row's start, the control (a
 * ToggleGroup, a Select, a Switch) at its end, an optional description
 * under the label and an `error` line in red under that. Rows of one group
 * sit against each other; groups are 16px apart.
 */
export function FieldRow({
  label,
  description,
  error,
  className,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: Control;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <Item size="sm" data-slot="dialog-field-row" className={cn("px-0", className)}>
      <ItemContent className="min-w-0">
        <ItemTitle id={id}>{label}</ItemTitle>
        {description ? <ItemDescription>{description}</ItemDescription> : null}
        {error ? (
          <ItemDescription id={errorId} className="line-clamp-none text-destructive">
            {error}
          </ItemDescription>
        ) : null}
      </ItemContent>
      <ItemActions className="shrink-0">
        {cloneElement(children, {
          "aria-labelledby": children.props["aria-labelledby"] ?? id,
          ...(error ? { "aria-describedby": errorId, "aria-invalid": true } : {}),
        })}
      </ItemActions>
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

/**
 * One decision in a confirm (clean up the worktree, delete the branch): a
 * Checkbox and its label, never a Switch. The label names the checkbox.
 */
export function CheckRow({
  label,
  checked,
  disabled,
  onCheckedChange,
  className,
}: {
  label: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
  className?: string;
}) {
  const id = useId();
  return (
    <label data-slot="dialog-check-row" className={cn("flex min-h-7 items-center gap-2 text-[13px] text-foreground", disabled && "opacity-50", className)}>
      <Checkbox checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} aria-labelledby={id} />
      <span id={id} className="min-w-0 truncate">
        {label}
      </span>
    </label>
  );
}
