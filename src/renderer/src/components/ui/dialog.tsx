import { X } from "@renderer/chrome/icons";
import type { ComponentProps } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@renderer/lib/cn";
import { Button } from "./button";

/**
 * The one modal, and the alert dialog that confirms. Centred, one radius,
 * one hairline ring, one shadow; it fades, grows from 0.95 and rises 4px
 * in, fades and settles to 0.98 out. Transitions, not keyframes, so a close
 * mid-open turns back from where it is; the entry is CSS @starting-style
 * because Base UI sets no starting status on a popup that mounts open. The AlertDialog aliases keep the confirm shape in one file.
 */
function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({ className, ...props }: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-(--layer-dialog) bg-scrim transition-opacity duration-(--dur-slow) ease-(--ease-out) starting:opacity-0 data-ending-style:opacity-0 data-ending-style:duration-(--dur-fast) data-ending-style:ease-(--ease-exit)",
        className,
      )}
      {...props}
    />
  );
}

const dialogContentVariants = cva(
  "fixed left-1/2 top-1/2 z-(--layer-dialog) grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-2xl bg-popover p-5 text-sm leading-[22px] text-popover-foreground shadow-overlay ring-1 ring-border outline-none transition-[opacity,scale,translate] duration-(--dur-slow) ease-(--ease-out) starting:opacity-0 starting:scale-95 starting:translate-y-[calc(-50%+4px)] data-ending-style:opacity-0 data-ending-style:scale-[0.98] data-ending-style:duration-(--dur-fast) data-ending-style:ease-(--ease-exit) motion-reduce:transition-opacity",
  {
    variants: {
      size: {
        sm: "sm:max-w-sm",
        default: "sm:max-w-md",
        md: "sm:max-w-xl",
        lg: "sm:max-w-3xl",
        /* A viewer: the window less 24px each side, no surface of its own. */
        full: "inset-6 h-[calc(100vh-48px)] w-[calc(100vw-48px)] max-w-none translate-x-0 translate-y-0 starting:translate-y-1 bg-transparent shadow-none ring-0 sm:max-w-none",
      },
    },
    defaultVariants: { size: "default" },
  },
);

function DialogContent({
  className,
  children,
  showCloseButton = true,
  size,
  ...props
}: DialogPrimitive.Popup.Props & { showCloseButton?: boolean } & VariantProps<typeof dialogContentVariants>) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup data-slot="dialog-content" data-size={size ?? "default"} className={cn(dialogContentVariants({ size }), className)} {...props}>
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            aria-label="Close"
            // Seated 18px down, so its centre is the title line's (the 20px inset plus half a 24px line).
            render={<Button variant="ghost" size="icon-sm" className="absolute end-4 top-4.5 text-muted-foreground" />}
          >
            <X />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="dialog-header" className={cn("flex flex-col gap-1 pe-8", className)} {...props} />;
}

function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="dialog-footer" className={cn("mt-1 flex flex-row justify-end gap-2", className)} {...props} />;
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return <DialogPrimitive.Title data-slot="dialog-title" className={cn("text-base font-semibold leading-6 tracking-[-0.01em] text-balance", className)} {...props} />;
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return <DialogPrimitive.Description data-slot="dialog-description" className={cn("text-sm leading-[22px] text-pretty text-muted-foreground", className)} {...props} />;
}

function AlertDialogContent({ className, ...props }: ComponentProps<typeof DialogContent>) {
  return <DialogContent role="alertdialog" data-slot="alert-dialog-content" showCloseButton={false} size="sm" className={cn(className)} {...props} />;
}

function AlertDialogCancel({
  className,
  variant = "secondary",
  size = "default",
  ...props
}: ComponentProps<typeof DialogClose> & Pick<ComponentProps<typeof Button>, "variant" | "size">) {
  return <DialogClose data-slot="alert-dialog-cancel" className={cn(className)} render={<Button variant={variant} size={size} />} {...props} />;
}

function AlertDialogAction({ className, ...props }: ComponentProps<typeof Button>) {
  return <Button data-slot="alert-dialog-action" className={cn(className)} {...props} />;
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
  Dialog as AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  DialogDescription as AlertDialogDescription,
  DialogFooter as AlertDialogFooter,
  DialogHeader as AlertDialogHeader,
  DialogTitle as AlertDialogTitle,
  DialogTrigger as AlertDialogTrigger,
};
