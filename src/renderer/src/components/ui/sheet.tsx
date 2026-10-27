import { X } from "@renderer/chrome/icons";
import type { ComponentProps } from "react";
import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import { cn } from "@renderer/lib/cn";

/** A dialog that enters from an edge: slides 16px and fades, on the drawer
 *  curve; 300ms in, 200ms out. For CRUD forms and long lists; the one
 *  right panel is NOT a sheet. */
function Sheet({ ...props }: SheetPrimitive.Root.Props) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger({ ...props }: SheetPrimitive.Trigger.Props) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose({ ...props }: SheetPrimitive.Close.Props) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetPortal({ ...props }: SheetPrimitive.Portal.Props) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

function SheetOverlay({ className, ...props }: SheetPrimitive.Backdrop.Props) {
  return (
    <SheetPrimitive.Backdrop
      data-slot="sheet-overlay"
      className={cn("fixed inset-0 z-(--layer-dialog) bg-black/30 transition-opacity duration-(--dur-slow) data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none", className)}
      {...props}
    />
  );
}

function SheetContent({
  className,
  children,
  side = "right",
  showCloseButton = true,
  width,
  style,
  ...props
}: SheetPrimitive.Popup.Props & {
  side?: "top" | "right" | "bottom" | "left";
  showCloseButton?: boolean;
  /** A left or right sheet's width in px, in place of the default 440. */
  width?: number;
}) {
  const sized = width !== undefined && (side === "left" || side === "right");
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        data-side={side}
        className={cn(
          "fixed z-(--layer-dialog) flex flex-col overflow-hidden rounded-2xl bg-popover text-sm text-popover-foreground shadow-overlay ring-1 ring-border transition duration-(--dur-drawer) ease-(--ease-drawer) data-ending-style:opacity-0 data-ending-style:duration-(--dur-slow) data-starting-style:opacity-0 motion-reduce:transition-none",
          "data-[side=bottom]:inset-x-3 data-[side=bottom]:bottom-3 data-[side=bottom]:h-auto data-[side=bottom]:data-ending-style:translate-y-4 data-[side=bottom]:data-starting-style:translate-y-4",
          "data-[side=top]:inset-x-3 data-[side=top]:top-3 data-[side=top]:h-auto data-[side=top]:data-ending-style:-translate-y-4 data-[side=top]:data-starting-style:-translate-y-4",
          "data-[side=left]:inset-y-3 data-[side=left]:left-3 data-[side=left]:w-[440px] data-[side=left]:max-w-[calc(100%-1.5rem)] data-[side=left]:data-ending-style:-translate-x-4 data-[side=left]:data-starting-style:-translate-x-4",
          "data-[side=right]:inset-y-3 data-[side=right]:right-3 data-[side=right]:w-[440px] data-[side=right]:max-w-[calc(100%-1.5rem)] data-[side=right]:data-ending-style:translate-x-4 data-[side=right]:data-starting-style:translate-x-4",
          className,
        )}
        style={sized ? (state) => ({ ...(typeof style === "function" ? style(state) : style), width }) : style}
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close
            data-slot="sheet-close"
            className="absolute end-3.5 top-3.5 inline-flex size-7 items-center justify-center rounded-full text-muted-foreground outline-none transition-[background-color,color] duration-(--dur-fast) hover:bg-foreground/7 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-4" />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Popup>
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="sheet-header" className={cn("flex flex-col gap-1 p-5 pe-12", className)} {...props} />;
}

function SheetFooter({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="sheet-footer" className={cn("mt-auto flex flex-row justify-end gap-2 p-5", className)} {...props} />;
}

function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
  return <SheetPrimitive.Title data-slot="sheet-title" className={cn("text-base font-semibold leading-tight tracking-tight text-foreground", className)} {...props} />;
}

function SheetDescription({ className, ...props }: SheetPrimitive.Description.Props) {
  return <SheetPrimitive.Description data-slot="sheet-description" className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

export { Sheet, SheetTrigger, SheetClose, SheetContent, SheetHeader, SheetFooter, SheetTitle, SheetDescription };
