import type { ComponentProps } from "react";
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@renderer/lib/cn";
import { Button } from "./button";

/** A file on its way into a turn, or shown in one: a media tile, a name,
 *  one line under it, an action at the end. `state` tints and shimmers. */
const attachmentVariants = cva(
  "group/attachment relative flex w-fit min-w-0 max-w-full shrink-0 flex-wrap rounded-lg border border-border bg-card text-card-foreground transition-[background-color,border-color] duration-(--dur-fast) focus-within:ring-2 focus-within:ring-ring has-[>a,>button]:hover:bg-muted/50 data-[state=error]:border-destructive/40 data-[state=idle]:border-dashed",
  {
    variants: {
      size: {
        default: "gap-2 text-[13px] has-data-[slot=attachment-content]:px-2.5 has-data-[slot=attachment-content]:py-2 has-data-[slot=attachment-media]:p-2",
        sm: "gap-2 text-xs has-data-[slot=attachment-content]:px-2 has-data-[slot=attachment-content]:py-1.5 has-data-[slot=attachment-media]:p-1.5",
        xs: "gap-1.5 rounded-md text-xs has-data-[slot=attachment-content]:px-1.5 has-data-[slot=attachment-content]:py-1 has-data-[slot=attachment-media]:p-1",
      },
      orientation: { horizontal: "min-w-40 items-center", vertical: "w-24 flex-col has-data-[slot=attachment-content]:w-30" },
    },
  },
);

type AttachmentState = "idle" | "uploading" | "processing" | "error" | "done";

function Attachment({
  className,
  state = "done",
  size = "default",
  orientation = "horizontal",
  ...props
}: ComponentProps<"div"> & VariantProps<typeof attachmentVariants> & { state?: AttachmentState }) {
  return <div data-slot="attachment" data-state={state} data-size={size} data-orientation={orientation} className={cn(attachmentVariants({ size, orientation }), className)} {...props} />;
}

const attachmentMediaVariants = cva(
  "relative flex aspect-square w-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground group-data-[orientation=vertical]/attachment:w-full group-data-[size=sm]/attachment:w-8 group-data-[size=xs]/attachment:w-6 group-data-[state=error]/attachment:bg-destructive/10 group-data-[state=error]/attachment:text-destructive [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 group-data-[size=xs]/attachment:[&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        icon: "",
        image: "opacity-60 group-data-[state=done]/attachment:opacity-100 group-data-[state=idle]/attachment:opacity-100 *:[img]:aspect-square *:[img]:w-full *:[img]:object-cover",
      },
    },
    defaultVariants: { variant: "icon" },
  },
);

function AttachmentMedia({ className, variant = "icon", ...props }: ComponentProps<"div"> & VariantProps<typeof attachmentMediaVariants>) {
  return <div data-slot="attachment-media" data-variant={variant} className={cn(attachmentMediaVariants({ variant }), className)} {...props} />;
}

function AttachmentContent({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="attachment-content" className={cn("min-w-0 max-w-full flex-1 leading-tight group-data-[orientation=vertical]/attachment:px-1", className)} {...props} />;
}

function AttachmentTitle({ className, ...props }: ComponentProps<"span">) {
  return <span data-slot="attachment-title" className={cn("block min-w-0 max-w-full truncate font-medium text-foreground group-data-[state=processing]/attachment:shimmer group-data-[state=uploading]/attachment:shimmer", className)} {...props} />;
}

function AttachmentDescription({ className, ...props }: ComponentProps<"span">) {
  return <span data-slot="attachment-description" className={cn("mt-0.5 block min-w-0 max-w-full truncate text-xs text-muted-foreground group-data-[state=error]/attachment:text-destructive/80", className)} {...props} />;
}

function AttachmentActions({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="attachment-actions" className={cn("relative z-20 flex shrink-0 items-center group-data-[orientation=vertical]/attachment:absolute group-data-[orientation=vertical]/attachment:end-2 group-data-[orientation=vertical]/attachment:top-2 group-data-[orientation=vertical]/attachment:gap-1", className)} {...props} />;
}

function AttachmentAction({ className, variant, size = "icon-xs", ...props }: ComponentProps<typeof Button>) {
  return <Button data-slot="attachment-action" variant={variant ?? "ghost"} size={size} className={cn(className)} {...props} />;
}

function AttachmentTrigger({ className, render, type, ...props }: useRender.ComponentProps<"button">) {
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">({ type: render ? type : (type ?? "button"), className: cn("absolute inset-0 z-10 outline-none", className) }, props),
    render,
    state: { slot: "attachment-trigger" },
  });
}

const attachmentGroupVariants = cva("min-w-0 gap-2 py-1", {
  variants: {
    layout: {
      scroll: "flex snap-x snap-mandatory scroll-px-1 overflow-x-auto overscroll-x-contain scrollbar-none *:data-[slot=attachment]:flex-none *:data-[slot=attachment]:snap-start",
      grid: "grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] *:data-[slot=attachment]:w-full",
    },
  },
  defaultVariants: { layout: "scroll" },
});

function AttachmentGroup({ className, layout = "scroll", ...props }: ComponentProps<"div"> & VariantProps<typeof attachmentGroupVariants>) {
  return <div data-slot="attachment-group" data-layout={layout} className={cn(attachmentGroupVariants({ layout }), className)} {...props} />;
}

export { Attachment, AttachmentGroup, AttachmentMedia, AttachmentContent, AttachmentTitle, AttachmentDescription, AttachmentActions, AttachmentAction, AttachmentTrigger, type AttachmentState };
