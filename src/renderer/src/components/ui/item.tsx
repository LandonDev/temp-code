import type { ComponentProps } from "react";
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@renderer/lib/cn";
import { Separator } from "./separator";

/**
 * The one row for lists and settings: media, a title with a description
 * under it, actions at the end. A settings page is a column of these;
 * hierarchy comes from the title weight and the muted description, never
 * from bullets or separators between every row.
 */
function ItemGroup({ className, ...props }: ComponentProps<"div">) {
  return <div role="list" data-slot="item-group" className={cn("group/item-group flex w-full flex-col", className)} {...props} />;
}

function ItemSeparator({ className, ...props }: ComponentProps<typeof Separator>) {
  return <Separator data-slot="item-separator" orientation="horizontal" className={cn("my-2", className)} {...props} />;
}

const itemVariants = cva(
  "group/item flex w-full flex-wrap items-center rounded-lg border text-sm transition-[border-color] duration-(--dur-fast) [a]:hover:bg-muted focus-ring",
  {
    variants: {
      variant: { default: "border-transparent", outline: "border-border", muted: "border-transparent bg-muted/50" },
      size: { default: "gap-3 px-3 py-2.5", sm: "gap-2.5 px-2.5 py-2", xs: "gap-2 px-2 py-1.5" },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

function Item({ className, variant = "default", size = "default", render, ...props }: useRender.ComponentProps<"div"> & VariantProps<typeof itemVariants>) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">({ className: cn(itemVariants({ variant, size, className })) }, props),
    render,
    state: { slot: "item", variant, size },
  });
}

/** An `Item` that is one button: a list row the whole of which acts (open,
 *  pick, restore). Flat like the row; the caller names its hover fill.
 *  `surface="group"` is a container in the chrome that sits on the
 *  `sidebar-group` steps (a project card in the workspace column, as
 *  RailRow's group): its own fill at rest, a step on hover, the farthest
 *  while pressed or current, and no item padding (the caller lays it out). */
function ItemButton({
  className,
  variant = "default",
  size = "default",
  surface = "item",
  type = "button",
  ...props
}: ComponentProps<"button"> & VariantProps<typeof itemVariants> & { surface?: "item" | "group" }) {
  return (
    <button
      type={type}
      data-slot="item"
      data-variant={variant}
      data-size={size}
      data-surface={surface === "group" ? "group" : undefined}
      className={cn(
        surface === "group"
          ? "group/item flex w-full rounded-lg text-start focus-ring bg-sidebar-group hover:bg-sidebar-group-hover active:bg-sidebar-group-selected aria-[current=true]:bg-sidebar-group-selected aria-[current=true]:hover:bg-sidebar-group-selected"
          : [itemVariants({ variant, size }), "text-start active:bg-foreground/12"],
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

const itemMediaVariants = cva("flex shrink-0 items-center justify-center gap-2 text-muted-foreground group-has-data-[slot=item-description]/item:translate-y-0.5 group-has-data-[slot=item-description]/item:self-start [&_svg]:pointer-events-none", {
  variants: {
    variant: {
      default: "bg-transparent [&_svg:not([class*='size-'])]:size-4",
      icon: "size-8 rounded-md bg-muted group-has-data-[slot=item-description]/item:translate-y-0 group-has-data-[slot=item-description]/item:self-center [&_svg:not([class*='size-'])]:size-4",
      image: "size-10 overflow-hidden rounded-md group-data-[size=sm]/item:size-8 group-data-[size=xs]/item:size-6 [&_img]:size-full [&_img]:object-cover",
    },
  },
  defaultVariants: { variant: "default" },
});

function ItemMedia({ className, variant = "default", ...props }: ComponentProps<"div"> & VariantProps<typeof itemMediaVariants>) {
  return <div data-slot="item-media" data-variant={variant} className={cn(itemMediaVariants({ variant, className }))} {...props} />;
}

function ItemContent({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="item-content" className={cn("flex flex-1 flex-col gap-0.5 group-data-[size=xs]/item:gap-0 [&+[data-slot=item-content]]:flex-none", className)} {...props} />;
}

function ItemTitle({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="item-title" className={cn("line-clamp-1 flex w-fit items-center gap-2 text-[13px] font-medium leading-5 text-foreground", className)} {...props} />;
}

/** A div, not a p: a description may hold a skeleton, a progress bar or a
 *  block line, which a paragraph cannot contain. */
function ItemDescription({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="item-description" className={cn("line-clamp-2 text-start text-xs font-normal leading-4 text-muted-foreground [&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-foreground", className)} {...props} />;
}

function ItemActions({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="item-actions" className={cn("flex items-center gap-2", className)} {...props} />;
}

function ItemHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="item-header" className={cn("flex basis-full items-center justify-between gap-2", className)} {...props} />;
}

function ItemFooter({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="item-footer" className={cn("flex basis-full items-center justify-between gap-2", className)} {...props} />;
}

export { Item, ItemButton, ItemMedia, ItemContent, ItemActions, ItemGroup, ItemSeparator, ItemTitle, ItemDescription, ItemHeader, ItemFooter };
