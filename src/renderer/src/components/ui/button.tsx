import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@renderer/lib/cn";
import { Spinner } from "./spinner";

/**
 * The one button. The solid variants are raised (Kobra's `t-raise` in
 * index.css): primary, the gray secondary and destructive red carry their own
 * shadow on a fill layer behind the label, which lightens on hover and
 * presses in to 0.985 while the label stays put. Ghost (icon and row
 * buttons), outline (inside forms) and link (inline text actions) are flat
 * and never move: a press steps the fill to foreground/12 at once and it
 * eases back over --dur-hover, as every row does.
 */
const buttonVariants = cva(
  "group/button relative isolate inline-flex shrink-0 cursor-default select-none items-center justify-center whitespace-nowrap rounded-lg text-[13px] leading-5 font-medium outline-none transition-[background-color,color,border-color] duration-(--dur-hover) ease-(--ease-out) disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none aria-invalid:ring-2 aria-invalid:ring-destructive/30 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [--busy-space:1rem]",
  {
    variants: {
      variant: {
        default: "t-raise t-raise-primary text-primary-foreground",
        secondary: "t-raise t-raise-secondary text-secondary-foreground",
        ghost:
          "text-foreground hover:bg-foreground/7 aria-expanded:bg-foreground/7 active:bg-foreground/12 active:transition-none data-pressed:bg-foreground/12",
        outline:
          "border border-border bg-transparent text-foreground hover:bg-muted active:bg-foreground/12 active:transition-none data-pressed:bg-foreground/12",
        destructive: "t-raise t-raise-destructive text-destructive-foreground",
        link: "text-foreground underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 gap-1.5 px-2.5 has-[>svg:first-child]:ps-2 has-[>svg:last-child]:pe-2",
        xs: "h-6 gap-1 rounded-md px-2 text-xs [&_svg:not([class*='size-'])]:size-3 [&_[data-slot=spinner]:not([class*='size-'])]:size-3 [--busy-space:0.75rem]",
        sm: "h-7 gap-1 rounded-md px-2.5 text-[13px] [&_svg:not([class*='size-'])]:size-3.5 [&_[data-slot=spinner]:not([class*='size-'])]:size-3.5 [--busy-space:0.875rem]",
        lg: "h-9 gap-2 px-4 has-[>svg:first-child]:ps-2 has-[>svg:last-child]:pe-2",
        icon: "size-8",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3 [&_[data-slot=spinner]:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 rounded-md [&_svg:not([class*='size-'])]:size-3.5 [&_[data-slot=spinner]:not([class*='size-'])]:size-3.5",
      },
      rounded: { true: "rounded-full", false: "" },
    },
    defaultVariants: { variant: "default", size: "default", rounded: false },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  rounded = false,
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      data-variant={variant}
      className={cn(buttonVariants({ variant, size, rounded, className }))}
      {...props}
    />
  );
}

/** The two unseen widths: zero-height copies of both states, the busy one
 *  padded by the spinner's place and the 4px gap beside it. */
const BUSY_WIDTHS =
  "grid grid-cols-1 before:invisible before:h-0 before:overflow-hidden before:content-[attr(data-idle)] after:invisible after:h-0 after:overflow-hidden after:ps-[calc(var(--busy-space,1rem)+0.25rem)] after:content-[attr(data-busy-text)]";

/**
 * A button's words through a busy state, holding the button's width. Both
 * states sit unseen in the same column as the shown one (its ::before and
 * ::after, no height), so the button keeps its widest width at rest and the
 * spinner appears beside the word without anything around it moving. The
 * unseen busy copy reserves the spinner's place as padding (`--busy-space`,
 * set by the button's size), never a spinner, so nothing turns at rest.
 * `busyLabel` defaults to `label`: a confirm keeps its verb and reserves only
 * the spinner's slot. `align="end"` sets the words at the reserved width's
 * end, for a button at a row's end whose word stands over something (the
 * slot's Stop over Send); the spinner then appears before them.
 */
function BusyLabel({
  busy,
  label,
  busyLabel = label,
  align = "center",
}: {
  busy: boolean;
  label: string;
  busyLabel?: string;
  align?: "center" | "end";
}) {
  return (
    <span data-slot="busy-label" data-busy={busy || undefined} data-idle={label} data-busy-text={busyLabel} className={BUSY_WIDTHS}>
      <span className={cn("inline-flex items-center gap-1", align === "end" ? "justify-end" : "justify-center")}>
        {busy ? (
          <>
            <Spinner aria-hidden style={{ width: "var(--busy-space, 1rem)", height: "var(--busy-space, 1rem)" }} />
            {busyLabel}
          </>
        ) : (
          label
        )}
      </span>
    </span>
  );
}

export { BusyLabel, Button, buttonVariants };
