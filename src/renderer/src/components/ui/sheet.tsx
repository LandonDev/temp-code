import { X } from "@renderer/chrome/icons";
import type { ComponentProps } from "react";
import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import { cn } from "@renderer/lib/cn";
import { Button } from "./button";

/** A dialog that enters from an edge: slides 16px and fades, on the drawer
 *  curve; 300ms in, 240ms back out by the same edge. Transitions, so a close
 *  mid-open turns back from where it is; the entry is CSS @starting-style,
 *  since Base UI skips the starting status of a popup that mounts open, as
 *  ours do. For CRUD forms and long lists; the one right panel is NOT a sheet. */
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
      className={cn("fixed inset-0 z-(--layer-dialog) bg-scrim transition-opacity duration-(--dur-drawer) ease-(--ease-drawer) starting:opacity-0 data-ending-style:opacity-0 data-ending-style:duration-(--dur-fast) data-ending-style:ease-(--ease-exit)", className)}
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
          "fixed z-(--layer-dialog) flex flex-col overflow-hidden rounded-2xl bg-popover text-sm text-popover-foreground shadow-overlay ring-1 ring-border transition-[opacity,translate] duration-(--dur-drawer) ease-(--ease-drawer) starting:opacity-0 data-ending-style:opacity-0 data-ending-style:duration-(--dur-slow) data-ending-style:ease-(--ease-exit)",
          // The slide rides motion-safe, so reduced motion keeps the fade alone.
          "data-[side=bottom]:inset-x-3 data-[side=bottom]:bottom-3 data-[side=bottom]:h-auto motion-safe:data-[side=bottom]:starting:translate-y-4 motion-safe:data-[side=bottom]:data-ending-style:translate-y-4",
          "data-[side=top]:inset-x-3 data-[side=top]:top-3 data-[side=top]:h-auto motion-safe:data-[side=top]:starting:-translate-y-4 motion-safe:data-[side=top]:data-ending-style:-translate-y-4",
          "data-[side=left]:inset-y-3 data-[side=left]:left-3 data-[side=left]:w-[440px] data-[side=left]:max-w-[calc(100%-1.5rem)] motion-safe:data-[side=left]:starting:-translate-x-4 motion-safe:data-[side=left]:data-ending-style:-translate-x-4",
          "data-[side=right]:inset-y-3 data-[side=right]:right-3 data-[side=right]:w-[440px] data-[side=right]:max-w-[calc(100%-1.5rem)] motion-safe:data-[side=right]:starting:translate-x-4 motion-safe:data-[side=right]:data-ending-style:translate-x-4",
          className,
        )}
        style={sized ? (state) => ({ ...(typeof style === "function" ? style(state) : style), width }) : style}
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close
            data-slot="sheet-close"
            aria-label="Close"
            // Seated 18px down, so its centre is the title line's (the 20px inset plus half a 24px line).
            render={<Button variant="ghost" size="icon-sm" className="absolute end-4 top-4.5 text-muted-foreground" />}
          >
            <X />
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
  return <SheetPrimitive.Title data-slot="sheet-title" className={cn("text-base font-semibold leading-6 tracking-[-0.01em] text-balance text-foreground", className)} {...props} />;
}

function SheetDescription({ className, ...props }: SheetPrimitive.Description.Props) {
  return <SheetPrimitive.Description data-slot="sheet-description" className={cn("text-sm leading-[22px] text-pretty text-muted-foreground", className)} {...props} />;
}

export { Sheet, SheetTrigger, SheetClose, SheetContent, SheetHeader, SheetFooter, SheetTitle, SheetDescription };
