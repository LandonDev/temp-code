import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@renderer/lib/cn";
import { SPRING_LAYOUT_CSS } from "@renderer/lib/ease";

/** Segmented control (`default`: a muted track, the active tab lifted) or
 *  a line of tabs (`line`: text only, a 2px underline). Keyboard-driven. */
function Tabs({ className, orientation = "horizontal", ...props }: TabsPrimitive.Root.Props) {
  return <TabsPrimitive.Root data-slot="tabs" orientation={orientation} className={cn("group/tabs flex gap-2 data-[orientation=horizontal]:flex-col", className)} {...props} />;
}

const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-[orientation=horizontal]/tabs:h-8 group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col data-[variant=line]:rounded-none data-[variant=line]:p-0",
  {
    variants: { variant: { default: "bg-muted", line: "gap-1 bg-transparent" } },
    defaultVariants: { variant: "default" },
  },
);

function TabsList({ className, variant = "default", ...props }: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  return <TabsPrimitive.List data-slot="tabs-list" data-variant={variant} className={cn(tabsListVariants({ variant }), className)} {...props} />;
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex h-full flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-[13px] font-medium text-muted-foreground outline-none transition-[background-color,color] duration-(--dur-fast) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start data-active:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "group-data-[variant=default]/tabs-list:data-active:bg-background group-data-[variant=default]/tabs-list:data-active:shadow-xs",
        "group-data-[variant=line]/tabs-list:rounded-none group-data-[variant=line]/tabs-list:px-1 group-data-[variant=line]/tabs-list:after:absolute group-data-[variant=line]/tabs-list:after:inset-x-0 group-data-[variant=line]/tabs-list:after:-bottom-px group-data-[variant=line]/tabs-list:after:h-0.5 group-data-[variant=line]/tabs-list:after:bg-foreground group-data-[variant=line]/tabs-list:after:opacity-0 group-data-[variant=line]/tabs-list:after:transition-opacity group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The segmented control's pill as one element that glides between tabs on
 * `SPRING_LAYOUT_CSS` (DESIGN.md's motion table). Put it first in a default
 * `TabsList` and give the triggers `TABS_PILL_TRIGGER`, so the pill is the
 * only lifted surface; reduced motion jumps.
 */
function TabsIndicator({ className, style, ...props }: TabsPrimitive.Indicator.Props) {
  return (
    <TabsPrimitive.Indicator
      data-slot="tabs-indicator"
      className={cn(
        "absolute top-(--active-tab-top) left-0 h-(--active-tab-height) w-(--active-tab-width) translate-x-(--active-tab-left) rounded-md bg-background shadow-xs transition-[translate,width] motion-reduce:transition-none",
        className,
      )}
      style={{ transitionDuration: `${SPRING_LAYOUT_CSS.ms}ms`, transitionTimingFunction: SPRING_LAYOUT_CSS.easing, ...(typeof style === "object" ? style : {}) }}
      {...props}
    />
  );
}

/** A trigger over `TabsIndicator`: above the pill, with no lift of its own. */
const TABS_PILL_TRIGGER =
  "z-10 group-data-[variant=default]/tabs-list:data-active:bg-transparent group-data-[variant=default]/tabs-list:data-active:shadow-none";

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return <TabsPrimitive.Panel data-slot="tabs-content" className={cn("flex-1 text-sm outline-none", className)} {...props} />;
}

export { Tabs, TabsList, TabsTrigger, TabsIndicator, TABS_PILL_TRIGGER, TabsContent, tabsListVariants };
