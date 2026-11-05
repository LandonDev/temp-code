import { useState, useSyncExternalStore, type ReactNode } from "react";
import { BusyLabel, Button } from "@renderer/components/ui/button";
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
import { useClosingDialog, useModalClose } from "./Modal";

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ErrorLine({ error }: { error: string | null }) {
  return error ? <p className="whitespace-pre-wrap text-xs text-destructive">{error}</p> : null;
}

/** A dialog's footer, the one every form dialog ends in: a hairline, then
 *  at the start an optional `start` action of the dialog's own (Remove
 *  override, Clear, Delete) and a quiet `note` (where a save lands, or why it
 *  cannot), then Cancel, any extra verbs (`children`), and the confirm, which
 *  holds its width through `BusyLabel` while pending. With no `onCancel` the
 *  footer has no Cancel (a Done once nothing is left to cancel). */
export function DialogFooter({
  onCancel,
  confirmLabel,
  busyLabel,
  danger,
  pending,
  busy,
  disabled,
  onConfirm,
  closeOnConfirm,
  note,
  start,
  children,
}: {
  note?: ReactNode;
  /** An action of the dialog's own at the footer's start. */
  start?: ReactNode;
  /** Verbs between Cancel and the confirm (Commit & switch). */
  children?: ReactNode;
  onCancel?: () => void;
  /** Absent: no confirm (a footer that only cancels while it waits). */
  confirmLabel?: string;
  /** The confirm's words while pending, when they change ("Starting…"). */
  busyLabel?: string;
  danger?: boolean;
  /** The confirm's work is in flight: it spins, and Cancel waits. */
  pending?: boolean;
  /** Another of the footer's verbs is in flight: Cancel and the confirm wait. */
  busy?: boolean;
  disabled?: boolean;
  onConfirm?: () => void;
  /** The verb ends the dialog: it plays the exit, then runs `onConfirm`
   *  (a parent that unmounts the dialog on confirm would cut it). */
  closeOnConfirm?: boolean;
}) {
  const close = useModalClose();
  const confirm = onConfirm && closeOnConfirm && close ? () => close(onConfirm) : onConfirm;
  return (
    <div data-slot="dialog-footer" className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 pt-4 pb-5">
      {start || note ? (
        <div data-footer-start className="me-auto flex min-w-0 items-center gap-2">
          {start}
          {note ? (
            <span data-footer-note className="min-w-0 truncate text-xs text-muted-foreground">
              {note}
            </span>
          ) : null}
        </div>
      ) : null}
      {onCancel ? (
        <Button data-dialog-cancel variant="secondary" disabled={pending || busy} onClick={() => (close ? close(onCancel) : onCancel())}>
          Cancel
        </Button>
      ) : null}
      {children}
      {confirmLabel ? (
        <Button
          data-dialog-confirm
          type={onConfirm ? "button" : "submit"}
          variant={danger ? "destructive" : "default"}
          onClick={confirm}
          disabled={pending || busy || disabled}
        >
          <BusyLabel busy={!!pending} label={confirmLabel} busyLabel={busyLabel} />
        </Button>
      ) : null}
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
  onDone,
}: {
  title: string;
  body?: string;
  /** One specific fact under the body (what this move carries), a notch stronger than it. */
  note?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
  /** The confirm landed: the dialog plays its exit, then this runs. The
   *  parent clears its state here, never in `onConfirm`, so the verb's
   *  close plays the same exit as Cancel's. */
  onDone: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { root, closeThen } = useClosingDialog(onCancel, pending);
  const confirm = async () => {
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      // The verb stays spinning through the exit, so it cannot be pressed
      // again and Cancel cannot replace the landing.
      closeThen(onDone);
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
            <BusyLabel busy={pending} label={confirmLabel} />
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
  // The caller hears its answer at once; the head leaves the queue only after
  // the dialog's exit, so the verb fades out as Cancel does.
  const drop = () => publish(queue.filter((entry) => entry !== head));
  return (
    <ConfirmDialog
      key={head.id}
      title={head.title}
      body={head.body}
      confirmLabel={head.action}
      danger={head.danger}
      onCancel={() => {
        drop();
        head.resolve(false);
      }}
      onConfirm={() => head.resolve(true)}
      onDone={drop}
    />
  );
}
