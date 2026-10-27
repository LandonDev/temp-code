import { useState, useSyncExternalStore, type ReactNode } from "react";
import { Button, buttonVariants } from "@renderer/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@renderer/components/ui/dialog";
import { Spinner } from "@renderer/components/ui/spinner";
import { useClosingDialog, useModalClose } from "./Modal";

/** The dialog button kit, for buttons a dialog lays out by hand. */
export const GHOST = buttonVariants({ variant: "ghost" });
export const PRIMARY = buttonVariants();
export const DANGER = buttonVariants({ variant: "destructive" });

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ErrorLine({ error }: { error: string | null }) {
  return error ? <p className="whitespace-pre-wrap text-xs text-destructive">{error}</p> : null;
}

/** Modal footer: a hairline, Cancel at left of the confirm, the confirm
 *  showing a spinner while pending; an optional quiet note at the far left
 *  (where a save lands, or why it cannot). */
export function DialogFooter({
  onCancel,
  confirmLabel,
  danger,
  pending,
  disabled,
  onConfirm,
  note,
}: {
  note?: ReactNode;
  onCancel: () => void;
  confirmLabel: string;
  danger?: boolean;
  pending?: boolean;
  disabled?: boolean;
  onConfirm?: () => void;
}) {
  const close = useModalClose();
  return (
    <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
      {note ? (
        <span data-footer-note className="me-auto min-w-0 truncate text-xs text-muted-foreground">
          {note}
        </span>
      ) : null}
      <Button variant="secondary" onClick={() => (close ? close(onCancel) : onCancel())}>
        Cancel
      </Button>
      <Button
        type={onConfirm ? "button" : "submit"}
        variant={danger ? "destructive" : "default"}
        onClick={onConfirm}
        disabled={pending || disabled}
      >
        {pending ? <Spinner /> : null}
        {confirmLabel}
      </Button>
    </div>
  );
}

/** One-clause confirmation for an irreversible action. `onConfirm` may be
 *  async; its rejection shows inline and the dialog stays open. */
export function ConfirmDialog({
  title,
  body,
  note,
  confirmLabel,
  danger,
  onCancel,
  onConfirm,
}: {
  title: string;
  body?: string;
  /** One specific fact under the body (what this move carries), a notch stronger than it. */
  note?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { root } = useClosingDialog(onCancel, pending);
  const confirm = async () => {
    setPending(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(errorText(err));
      setPending(false);
    }
  };
  return (
    <AlertDialog {...root}>
      <AlertDialogContent aria-busy={pending || undefined}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {body ? <AlertDialogDescription>{body}</AlertDialogDescription> : null}
          {note ? (
            <p data-confirm-note className="text-sm text-foreground">
              {note}
            </p>
          ) : null}
        </AlertDialogHeader>
        <ErrorLine error={error} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant={danger ? "destructive" : "default"} disabled={pending} onClick={() => void confirm()}>
            {pending ? <Spinner /> : null}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export type ConfirmRequest = { title: string; body?: string; action: string; danger?: boolean };

type Pending = ConfirmRequest & { id: number; resolve: (ok: boolean) => void };

let queue: Pending[] = [];
let nextId = 0;
const listeners = new Set<() => void>();
const publish = (next: Pending[]) => {
  queue = next;
  for (const listener of listeners) listener();
};

/** Ask before an irreversible step; resolves true on the verb, false on
 *  Cancel, Escape or the backdrop. Requests queue and show one at a time. */
export function confirmAction(request: ConfirmRequest): Promise<boolean> {
  return new Promise((resolve) => publish([...queue, { ...request, id: nextId++, resolve }]));
}

export function useConfirm() {
  return confirmAction;
}

/** Renders the request at the head of the queue; mounted once beside the app. */
export function ConfirmHost() {
  const head = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => queue[0],
  );
  if (!head) return null;
  const settle = (ok: boolean) => {
    publish(queue.filter((entry) => entry !== head));
    head.resolve(ok);
  };
  return (
    <ConfirmDialog
      key={head.id}
      title={head.title}
      body={head.body}
      confirmLabel={head.action}
      danger={head.danger}
      onCancel={() => settle(false)}
      onConfirm={() => settle(true)}
    />
  );
}
