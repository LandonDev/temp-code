import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { cn } from "@renderer/lib/cn";

const TOOLTIP_DELAY = 400;
const TOOLTIP_CLOSE_DELAY = 120;

/** The Base UI tooltip, loaded by components/ui/tooltip.tsx on the first
 *  hover: import from tooltip.tsx, never from here. */
function TooltipProvider({ delay = TOOLTIP_DELAY, closeDelay = TOOLTIP_CLOSE_DELAY, ...props }: TooltipPrimitive.Provider.Props) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delay={delay} closeDelay={closeDelay} {...props} />;
}

function Tooltip<Payload>({ ...props }: TooltipPrimitive.Root.Props<Payload>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger<Payload>({ delay = TOOLTIP_DELAY, closeDelay = TOOLTIP_CLOSE_DELAY, ...props }: TooltipPrimitive.Trigger.Props<Payload>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" delay={delay} closeDelay={closeDelay} {...props} />;
}

const createTooltipHandle = TooltipPrimitive.createHandle;

function TooltipContent({
  className,
  side = "top",
  sideOffset = 6,
  align = "center",
  alignOffset = 0,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<TooltipPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-(--layer-tooltip) max-w-(--available-width) transition-[top,right,bottom,left,transform] duration-(--dur-base) ease-(--ease-out) data-instant:transition-none motion-reduce:transition-none"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            "inline-flex max-w-xs origin-(--transform-origin) items-center justify-center gap-1.5 rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background transition-[transform,opacity] duration-(--dur-base) ease-(--ease-out) data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-ending-style:duration-(--dur-fast) data-instant:transition-none data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-none **:data-[slot=kbd]:h-[18px] **:data-[slot=kbd]:min-w-[18px] **:data-[slot=kbd]:rounded-sm **:data-[slot=kbd]:text-[11px]",
            className,
          )}
          {...props}
        >
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

function TooltipArrow({ className, ...props }: TooltipPrimitive.Arrow.Props) {
  return (
    <TooltipPrimitive.Arrow
      data-slot="tooltip-arrow"
      className={cn(
        "absolute size-2 rotate-45 rounded-[1px] bg-foreground data-[side=bottom]:-top-1 data-[side=left]:-right-1 data-[side=right]:-left-1 data-[side=top]:-bottom-1",
        className,
      )}
      {...props}
    />
  );
}

export { createTooltipHandle, Tooltip, TooltipArrow, TooltipTrigger, TooltipContent, TooltipProvider };
