import { useState } from "react";
import { Modal } from "./Modal";
import { MatrixSpinner } from "../surfaces/threads/bits";

/** The dialog button kit: ghost secondary, filled primary, filled danger. */
export const GHOST =
  "pressable rounded-md px-3 py-1.5 text-[12px] text-content/70 hover:bg-content/8 hover:text-content disabled:cursor-default disabled:opacity-40";
export const PRIMARY =
  "pressable flex items-center gap-2 rounded-md bg-content px-3 py-1.5 text-[12px] font-medium text-background-base hover:bg-content/70 disabled:cursor-default disabled:opacity-50";
export const DANGER =
  "pressable flex items-center gap-2 rounded-md bg-danger/20 px-3 py-1.5 text-[12px] font-medium text-danger hover:bg-danger/30 disabled:cursor-default disabled:opacity-50";

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p className="whitespace-pre-wrap text-[11px] leading-4 text-danger">{error}</p>
  ) : null;
}

/** Modal footer: a hairline, Cancel at left of the confirm, the confirm
 *  showing a spinner while pending. */
export function DialogFooter({
  onCancel,
  confirmLabel,
  danger,
  pending,
  disabled,
  onConfirm,
}: {
  onCancel: () => void;
  confirmLabel: string;
  danger?: boolean;
  pending?: boolean;
  disabled?: boolean;
  onConfirm?: () => void;
}) {
  return (
    <div className="flex items-center justify-end gap-2 border-t border-content/10 px-4 py-3">
      <button type="button" onClick={onCancel} className={GHOST}>
        Cancel
      </button>
      <button
        type={onConfirm ? "button" : "submit"}
        onClick={onConfirm}
        disabled={pending || disabled}
        className={danger ? DANGER : PRIMARY}
      >
        {pending ? <MatrixSpinner cell={1.5} /> : null}
        {confirmLabel}
      </button>
    </div>
  );
}

/** One-clause confirmation for an irreversible action. `onConfirm` may be
 *  async; its rejection shows inline and the dialog stays open. */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    <Modal onClose={onCancel} busy={pending} title={title} size="sm">
      <div className="flex flex-col gap-2 px-4 py-3">
        <p className="text-[12px] leading-snug text-content/50">{body}</p>
        <ErrorLine error={error} />
      </div>
      <DialogFooter
        onCancel={onCancel}
        onConfirm={confirm}
        confirmLabel={confirmLabel}
        danger={danger}
        pending={pending}
      />
    </Modal>
  );
}
