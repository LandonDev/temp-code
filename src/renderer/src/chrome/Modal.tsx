import { X } from "./icons";
import { createContext, useContext, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Button } from "@renderer/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@renderer/components/ui/dialog";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { cn } from "../lib/cn";

export type ModalSize = "sm" | "md" | "lg";

const SIZE = { sm: "default", md: "md", lg: "lg" } as const;

type Props = {
  onClose: () => void;
  /** Work in flight: Escape, the backdrop, and the close button all wait. */
  busy?: boolean;
  title: string;
  description?: string;
  size?: ModalSize;
  /** Extra classes on the panel (fixed height, etc). */
  className?: string;
  /** Where focus lands on open (Base UI's popup prop: a ref or a function).
   *  Default: a field that focused itself, else the close button. */
  initialFocus?: ComponentProps<typeof DialogContent>["initialFocus"];
  children: ReactNode;
};

/**
 * The parent unmounts a dialog outright, so a close the dialog starts
 * (Escape, the backdrop, the close button, a footer's Cancel) plays the exit
 * first and only then runs the parent's callback.
 */
export function useClosingDialog(onClose: () => void, busy: boolean) {
  const [open, setOpen] = useState(true);
  const then = useRef(onClose);
  const closeThen = (fn: () => void) => {
    then.current = fn;
    setOpen(false);
  };
  return {
    closeThen,
    root: {
      open,
      onOpenChange: (next: boolean) => {
        if (!next && !busy) closeThen(onClose);
      },
      onOpenChangeComplete: (next: boolean) => {
        if (!next) then.current();
      },
    },
  };
}

const CloseContext = createContext<((then: () => void) => void) | null>(null);

/** Inside a Modal: close it with its exit, then run `then`. */
export function useModalClose() {
  return useContext(CloseContext);
}

export function ModalPanel({ busy = false, title, description, size = "md", className, initialFocus, children }: Props) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const popup = useRef<HTMLDivElement>(null);
  const focusOnOpen = () => {
    const active = document.activeElement;
    return active instanceof HTMLElement && popup.current?.contains(active) ? active : true;
  };
  return (
    <DialogContent
      ref={popup}
      initialFocus={initialFocus ?? focusOnOpen}
      size={SIZE[size]}
      showCloseButton={false}
      aria-busy={busy || undefined}
      className={cn("flex max-h-[calc(100vh-4rem)] flex-col gap-0 overflow-hidden p-0", className)}
    >
      <header className="flex shrink-0 items-start gap-2 px-5 pt-5">
        <div className="min-w-0 flex-1">
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription className="mt-1 truncate text-xs">{description}</DialogDescription> : null}
        </div>
        <DialogClose
          aria-label="Close"
          disabled={busy}
          render={<Button variant="ghost" size="icon-sm" className="-me-1.5 -mt-1 text-muted-foreground" />}
        >
          <X />
        </DialogClose>
      </header>
      <div ref={lockOverscroll} className="min-h-0 flex-1 overflow-y-auto overscroll-none">
        {children}
      </div>
    </DialogContent>
  );
}

/** A dialog's body: the 20px inset every dialog shares, fields 16px apart. */
export function ModalBody({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-4 px-5 py-4", className)} {...props} />;
}

export function Modal(props: Props) {
  const { root, closeThen } = useClosingDialog(props.onClose, props.busy ?? false);
  return (
    <Dialog {...root}>
      <CloseContext.Provider value={closeThen}>
        <ModalPanel {...props} />
      </CloseContext.Provider>
    </Dialog>
  );
}
