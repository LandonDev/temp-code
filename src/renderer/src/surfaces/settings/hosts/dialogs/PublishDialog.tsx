import { useState, type ReactNode } from "react";
import { Textarea } from "@renderer/components/ui/textarea";
import { DialogFooter, ErrorLine, errorText } from "../../../../chrome/ConfirmDialog";
import { Field } from "../../../../chrome/DialogField";
import { Modal, useModalClose } from "../../../../chrome/Modal";

type Props = {
  notes: string;
  line: string;
  refusal: string | null;
  onClose: () => void;
  /** Starts the job; the dialog closes once it resolves. */
  onPublish: (notes: string) => Promise<void>;
};

export function PublishDialog(props: Props): ReactNode {
  const [pending, setPending] = useState(false);
  return (
    <Modal onClose={props.onClose} busy={pending} title="Publish Mac release" description={props.line} size="sm">
      <Body {...props} pending={pending} setPending={setPending} />
    </Modal>
  );
}

function Body({ notes: initial, refusal, onClose, onPublish, pending, setPending }: Props & { pending: boolean; setPending: (on: boolean) => void }) {
  const close = useModalClose();
  const [notes, setNotes] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const ready = !!notes.trim() && !refusal;
  const submit = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      await onPublish(notes.trim());
      setPending(false);
      if (close) close(onClose);
      else onClose();
    } catch (err) {
      setError(errorText(err));
      setPending(false);
    }
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) void submit();
      }}
    >
      <div className="flex flex-col gap-4 px-5 py-4">
        <Field label="Release notes">
          <Textarea value={notes} autoFocus rows={4} spellCheck={false} onChange={(e) => setNotes(e.target.value)} className="max-h-40 resize-none" />
        </Field>
        <ErrorLine error={error ?? refusal} />
      </div>
      <DialogFooter onCancel={onClose} confirmLabel="Publish" pending={pending} disabled={!ready} />
    </form>
  );
}
