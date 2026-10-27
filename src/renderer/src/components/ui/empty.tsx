import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@renderer/lib/cn";

/** The one empty state: a title, one line of guidance, at most one action.
 *  No illustration, no dashed box; it sits in the space the content will. */
function Empty({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="empty" className={cn("mx-auto flex w-full min-w-0 max-w-sm flex-1 flex-col items-center justify-center gap-4 p-6 text-center text-balance", className)} {...props} />;
}

function EmptyHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="empty-header" className={cn("flex max-w-sm flex-col items-center gap-1", className)} {...props} />;
}

const emptyMediaVariants = cva("mb-2 flex shrink-0 items-center justify-center text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0", {
  variants: {
    variant: {
      default: "bg-transparent [&_svg:not([class*='size-'])]:size-5",
      icon: "flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted [&_svg:not([class*='size-'])]:size-5",
    },
  },
  defaultVariants: { variant: "default" },
});

function EmptyMedia({ className, variant = "default", ...props }: ComponentProps<"div"> & VariantProps<typeof emptyMediaVariants>) {
  return <div data-slot="empty-icon" data-variant={variant} className={cn(emptyMediaVariants({ variant, className }))} {...props} />;
}

function EmptyTitle({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="empty-title" className={cn("text-sm font-medium text-foreground", className)} {...props} />;
}

function EmptyDescription({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="empty-description" className={cn("text-[13px] leading-relaxed text-muted-foreground [&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-foreground", className)} {...props} />;
}

function EmptyContent({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="empty-content" className={cn("flex w-full min-w-0 max-w-sm flex-col items-center gap-2 text-sm text-balance", className)} {...props} />;
}

export { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyContent, EmptyMedia };
