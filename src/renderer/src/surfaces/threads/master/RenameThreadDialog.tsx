import { useEffect, useRef, useState } from "react";
import { DialogFooter, ErrorLine, errorText } from "../../../chrome/ConfirmDialog";
import { Modal } from "../../../chrome/Modal";
import * as commands from "../../../lib/tcserver/commands";
import { Input } from "../../settingsBits";

/** Rename from a board row's menu: the board has no inline title to edit. */
export function RenameThreadDialog({ sessionId, title, onClose }: { sessionId: string; title: string; onClose: () => void }) {
  const [draft, setDraft] = useState(title);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = draft.trim();
  const field = useRef<HTMLInputElement>(null);
  // The panel lands focus on its close button; the caret belongs in the field.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      field.current?.focus();
      field.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, []);
  const save = async () => {
    if (!next || next === title) return onClose();
    setPending(true);
    try {
      await commands.rename(sessionId, next);
      onClose();
    } catch (err) {
      setError(errorText(err));
      setPending(false);
    }
  };
  return (
    <Modal onClose={onClose} busy={pending} title="Rename thread" size="sm">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="flex flex-col gap-2 px-4 pt-3 pb-4">
          <Input ref={field} aria-label="Title" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <ErrorLine error={error} />
        </div>
        <DialogFooter onCancel={onClose} confirmLabel="Rename" pending={pending} disabled={!next} />
      </form>
    </Modal>
  );
}
