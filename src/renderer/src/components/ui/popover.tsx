import type { ComponentProps } from "react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { cn } from "@renderer/lib/cn";

/** Floating content anchored to its trigger: scales from the anchor
 *  (transform-origin at the source), one surface, one ring, no arrow. */
function Popover({ ...props }: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverContent({
  children,
  className,
  align = "center",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 6,
  collisionAvoidance,
  anchor,
  positionMethod,
  positionerClassName,
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<PopoverPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset" | "collisionAvoidance" | "anchor" | "positionMethod"> & {
    positionerClassName?: string;
  }) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        collisionAvoidance={collisionAvoidance}
        anchor={anchor}
        positionMethod={positionMethod}
        className={cn("isolate z-(--layer-popover)", positionerClassName)}
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            "flex w-72 origin-(--transform-origin) flex-col gap-2.5 rounded-xl bg-popover p-2.5 text-sm text-popover-foreground shadow-overlay ring-1 ring-border outline-none duration-(--dur-base) ease-(--ease-out) data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-98 data-closed:duration-(--dur-fast) data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 motion-reduce:data-open:zoom-in-100 motion-reduce:data-closed:zoom-out-100",
            className,
          )}
          {...props}
        >
          {children}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

function PopoverHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="popover-header" className={cn("flex flex-col gap-0.5 text-sm", className)} {...props} />;
}

function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
  return <PopoverPrimitive.Title data-slot="popover-title" className={cn("text-sm font-medium", className)} {...props} />;
}

function PopoverDescription({ className, ...props }: PopoverPrimitive.Description.Props) {
  return <PopoverPrimitive.Description data-slot="popover-description" className={cn("text-muted-foreground", className)} {...props} />;
}

export { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger };
