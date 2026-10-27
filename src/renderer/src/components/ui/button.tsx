import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@renderer/lib/cn";

/**
 * The one button. Flat by design: a quiet solid primary, a gray secondary,
 * ghost for icon and row buttons, outline inside forms, destructive red,
 * link for inline text actions. Depth never comes from shadows here.
 */
const buttonVariants = cva(
  "group/button relative isolate inline-flex shrink-0 cursor-default select-none items-center justify-center whitespace-nowrap rounded-lg text-sm font-medium outline-none transition-[background-color,color,border-color,scale] duration-(--dur-fast) ease-(--ease-out) active:not-aria-[haspopup]:scale-[0.985] data-pressed:scale-[0.985] disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none motion-reduce:active:scale-100 aria-invalid:ring-2 aria-invalid:ring-destructive/30 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "text-foreground hover:bg-foreground/7 aria-expanded:bg-foreground/7 active:bg-foreground/12 data-pressed:bg-foreground/12",
        outline: "border border-border bg-transparent text-foreground hover:bg-muted",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        link: "text-foreground underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pe-2 has-data-[icon=inline-start]:ps-2",
        xs: "h-6 gap-1 rounded-md px-2 text-xs [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-md px-2.5 text-[13px] [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-2 px-4",
        icon: "size-8",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 rounded-md [&_svg:not([class*='size-'])]:size-3.5",
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

export { Button, buttonVariants };
