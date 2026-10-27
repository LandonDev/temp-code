import type { ComponentProps } from "react";
import { cn } from "@renderer/lib/cn";

const kbdSizes = {
  sm: "h-4 min-w-4 rounded-sm px-1 text-[10px] [&_svg:not([class*='size-'])]:size-2.5",
  md: "h-5 min-w-5 rounded-sm px-1 text-xs [&_svg:not([class*='size-'])]:size-3",
  lg: "h-6 min-w-6 rounded-md px-1.5 text-[13px] [&_svg:not([class*='size-'])]:size-3.5",
} as const;

type KbdSize = keyof typeof kbdSizes;

/** A key cap. Inside a menu row or a tooltip it loses its border and
 *  reads as part of the row. */
function Kbd({ className, size = "md", ...props }: ComponentProps<"kbd"> & { size?: KbdSize }) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex w-fit select-none items-center justify-center gap-1 border border-border bg-muted font-sans font-medium text-foreground in-data-[slot=context-menu-shortcut]:border-transparent in-data-[slot=dropdown-menu-item]:border-transparent in-data-[slot=tooltip-content]:border-transparent in-data-[slot=tooltip-content]:bg-background/20 in-data-[slot=tooltip-content]:text-background",
        kbdSizes[size],
        className,
      )}
      {...props}
    />
  );
}

function KbdGroup({ className, ...props }: ComponentProps<"kbd">) {
  return <kbd data-slot="kbd-group" className={cn("inline-flex items-center gap-1", className)} {...props} />;
}

export { Kbd, KbdGroup, kbdSizes, type KbdSize };
