import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@renderer/lib/cn";

/** A two-state button; pressed is a muted fill. */
const toggleVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-[13px] font-medium text-muted-foreground outline-none transition-[background-color,color] duration-(--dur-fast) hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-pressed:bg-muted data-pressed:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: { default: "bg-transparent", outline: "border border-border bg-transparent" },
      size: { default: "h-8 min-w-8 px-2", sm: "h-7 min-w-7 px-1.5 [&_svg:not([class*='size-'])]:size-3.5", xs: "h-6 min-w-6 px-1 text-xs [&_svg:not([class*='size-'])]:size-3" },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

function Toggle({ className, variant, size, ...props }: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  return <TogglePrimitive data-slot="toggle" data-variant={variant} data-size={size} className={cn(toggleVariants({ variant, size, className }))} {...props} />;
}

export { Toggle, toggleVariants };
