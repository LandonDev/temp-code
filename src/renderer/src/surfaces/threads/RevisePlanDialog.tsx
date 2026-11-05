import { useState } from "react";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { ModalBody, ModalPanel } from "../../chrome/Modal";
import { Dialog } from "../../components/ui/dialog";
import { Textarea } from "../../components/ui/textarea";

/** Asks what should change in the project plan and sends it as a turn in
 *  the plan's thread; an empty field sends the re-survey turn. */
export function RevisePlanDialog({
  open,
  onOpenChange,
  onSend,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSend: (ask: string) => Promise<void>;
}) {
  const [ask, setAsk] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setAsk("");
      setError(null);
    }
  }
  const send = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSend(ask.trim());
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => (next || !busy) && onOpenChange(next)}>
      <ModalPanel
        title="Revise the plan"
        size="sm"
        busy={busy}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
      >
        <ModalBody>
          <Textarea
            autoFocus
            value={ask}
            onChange={(e) => setAsk(e.target.value)}
            placeholder="What should change?"
            aria-label="What should change"
            disabled={busy}
          />
          <ErrorLine error={error} />
        </ModalBody>
        <DialogFooter
          onCancel={() => onOpenChange(false)}
          confirmLabel="Send"
          busyLabel="Sending…"
          pending={busy}
          onConfirm={() => void send()}
        />
      </ModalPanel>
    </Dialog>
  );
}
