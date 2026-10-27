import { useState, type ReactNode } from "react";
import { DialogFooter, ErrorLine, errorText } from "../../../../chrome/ConfirmDialog";
import { Modal } from "../../../../chrome/Modal";
import { INPUT_CLASS } from "../../../settingsBits";

export function PublishDialog({
  notes: initial,
  line,
  refusal,
  onClose,
  onPublish,
}: {
  notes: string;
  line: string;
  refusal: string | null;
  onClose: () => void;
  onPublish: (notes: string) => Promise<void>;
}): ReactNode {
  const [notes, setNotes] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      await onPublish(notes.trim());
    } catch (err) {
      setError(errorText(err));
      setPending(false);
    }
  };
  return (
    <Modal onClose={onClose} busy={pending} title="Publish Mac release" size="sm">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="flex flex-col gap-3 px-4 py-3">
          <p className="text-[12px] leading-snug text-content/50">{line}</p>
          <label className="flex flex-col gap-1.5 text-[12px] text-content/50">
            Release notes
            <textarea
              value={notes}
              autoFocus
              rows={4}
              spellCheck={false}
              onChange={(e) => setNotes(e.target.value)}
              className={`${INPUT_CLASS} resize-none leading-relaxed`}
            />
          </label>
          <p className="text-[11px] leading-4 text-content/40">
            Runs the local train (typecheck, tests, build, tag), then signs, notarizes and uploads to GitHub. The installed app offers it on its next check.
          </p>
          <ErrorLine error={error ?? refusal} />
        </div>
        <DialogFooter onCancel={onClose} confirmLabel="Publish" pending={pending} disabled={!notes.trim() || !!refusal} />
      </form>
    </Modal>
  );
}
