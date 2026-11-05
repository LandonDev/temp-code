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
  description?: ReactNode;
  size?: ModalSize;
  /** Extra classes on the panel (fixed height, etc). */
  className?: string;
  /** Where focus lands on open (Base UI's popup prop: a ref or a function).
   *  Default: `openFocusOf`. */
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

/** Where a Modal's focus lands on open: a field that focused itself, else
 *  the first text field, else the footer's confirm (when it is enabled and
 *  not destructive, so Enter does what the dialog is for), else its Cancel;
 *  never the close button, so Enter never quietly closes a dialog. */
export function openFocusOf(popup: HTMLElement | null): HTMLElement | true {
  if (!popup) return true;
  const active = document.activeElement;
  if (active instanceof HTMLElement && popup.contains(active)) return active;
  const field = popup.querySelector<HTMLElement>(
    'input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not(:disabled), textarea:not(:disabled)',
  );
  if (field) return field;
  const confirm = popup.querySelector<HTMLButtonElement>("[data-dialog-confirm]");
  if (confirm && !confirm.disabled && confirm.dataset.variant !== "destructive") return confirm;
  const cancel = popup.querySelector<HTMLButtonElement>("[data-dialog-cancel]");
  if (cancel && !cancel.disabled) return cancel;
  return true;
}

export function ModalPanel({ busy = false, title, description, size = "md", className, initialFocus, children }: Props) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const popup = useRef<HTMLDivElement>(null);
  const focusOnOpen = () => openFocusOf(popup.current);
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
          render={<Button variant="ghost" size="icon-sm" className="-me-1 -mt-0.5 text-muted-foreground" />}
        >
          <X />
        </DialogClose>
      </header>
      {/* One scroller per region (docs/DESIGN.md "Scrolling"): a flex column, so
          a list that marks itself min-h-0 shrinks under its cap before the
          body itself has to scroll. The inset keeps the thumb off the
          dialog's rounded corner. */}
      <div ref={lockOverscroll} className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-none [--scrollbar-inset:var(--radius-2xl)]">
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
