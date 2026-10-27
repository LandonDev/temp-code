import { useState } from "react";
import { Input } from "@renderer/components/ui/input";
import { DialogFooter, ErrorLine, errorText } from "../../../chrome/ConfirmDialog";
import { Modal, useModalClose } from "../../../chrome/Modal";
import * as commands from "../../../lib/tcserver/commands";

type Props = { sessionId: string; title: string; onClose: () => void };

/** Rename from a board row's menu: the board has no inline title to edit. */
export function RenameThreadDialog(props: Props) {
  const [pending, setPending] = useState(false);
  return (
    <Modal onClose={props.onClose} busy={pending} title="Rename thread" size="sm">
      <RenameForm {...props} pending={pending} setPending={setPending} />
    </Modal>
  );
}

function RenameForm({ sessionId, title, onClose, pending, setPending }: Props & { pending: boolean; setPending: (on: boolean) => void }) {
  const close = useModalClose();
  const [draft, setDraft] = useState(title);
  const [error, setError] = useState<string | null>(null);
  const next = draft.trim();
  const done = () => (close ? close(onClose) : onClose());
  const save = async () => {
    if (!next || next === title) return done();
    setPending(true);
    try {
      await commands.rename(sessionId, next);
      setPending(false);
      done();
    } catch (err) {
      setError(errorText(err));
      setPending(false);
    }
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-col gap-4 px-5 py-4">
        <Input autoFocus onFocus={(e) => e.currentTarget.select()} aria-label="Title" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <ErrorLine error={error} />
      </div>
      <DialogFooter onCancel={onClose} confirmLabel="Rename" pending={pending} disabled={!next} />
    </form>
  );
}
