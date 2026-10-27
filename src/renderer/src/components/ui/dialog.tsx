import { X } from "@renderer/chrome/icons";
import type { ComponentProps } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@renderer/lib/cn";
import { Button } from "./button";

/**
 * The one modal, and the alert dialog that confirms. Centred, one radius,
 * one hairline ring, one shadow; it fades and rises 4px in, fades and
 * settles out. The AlertDialog aliases keep the confirm shape in one file.
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
        "fixed inset-0 isolate z-(--layer-dialog) bg-black/30 duration-(--dur-slow) ease-(--ease-out) data-closed:animate-out data-closed:fade-out-0 data-open:animate-in data-open:fade-in-0",
        className,
      )}
      {...props}
    />
  );
}

const dialogContentVariants = cva(
  "fixed left-1/2 top-1/2 z-(--layer-dialog) grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-2xl bg-popover p-5 text-sm text-popover-foreground shadow-overlay ring-1 ring-border outline-none duration-(--dur-slow) ease-(--ease-out) data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-98 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-open:slide-in-from-bottom-1 motion-reduce:data-closed:zoom-out-100 motion-reduce:data-open:zoom-in-100 motion-reduce:data-open:slide-in-from-bottom-0",
  {
    variants: {
      size: {
        sm: "sm:max-w-sm",
        default: "sm:max-w-md",
        md: "sm:max-w-xl",
        lg: "sm:max-w-3xl",
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
      <DialogPrimitive.Popup data-slot="dialog-content" className={cn(dialogContentVariants({ size }), className)} {...props}>
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="absolute end-3.5 top-3.5 inline-flex size-7 items-center justify-center rounded-full text-muted-foreground outline-none transition-[background-color,color] duration-(--dur-fast) hover:bg-foreground/7 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-4" />
            <span className="sr-only">Close</span>
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
  return <DialogPrimitive.Title data-slot="dialog-title" className={cn("text-base font-semibold leading-tight tracking-tight", className)} {...props} />;
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return <DialogPrimitive.Description data-slot="dialog-description" className={cn("text-sm text-muted-foreground", className)} {...props} />;
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
