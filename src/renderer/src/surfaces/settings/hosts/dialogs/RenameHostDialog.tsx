import { useState } from "react";
import type { SavedEnvironment } from "@server/shared/contract-remote";
import { DialogFooter, ErrorLine } from "../../../../chrome/ConfirmDialog";
import { Modal } from "../../../../chrome/Modal";
import { hostErrorText } from "../../../../lib/hostConnection";
import { Input } from "../../../settingsBits";
import { rpc } from "../rpc";
import { FIELD } from "./fields";

export function RenameHostDialog({ env, onClose, onChanged }: { env: SavedEnvironment; onClose: () => void; onChanged: () => Promise<void> }) {
  const [name, setName] = useState(env.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      await rpc("remote.environments.update", { id: env.id, name: name.trim() });
      await onChanged();
      onClose();
    } catch (err) {
      setError(hostErrorText(err));
      setPending(false);
    }
  };
  return (
    <Modal onClose={onClose} busy={pending} title={`Rename ${env.name}`} size="sm">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void submit();
        }}
      >
        <div className="flex flex-col gap-3 px-4 py-3">
          <label className={FIELD}>
            Name
            <Input value={name} autoFocus onChange={(e) => setName(e.target.value)} spellCheck={false} autoComplete="off" data-environment-field="rename" />
          </label>
          <ErrorLine error={error} />
        </div>
        <DialogFooter onCancel={onClose} confirmLabel="Rename" pending={pending} disabled={!name.trim() || name.trim() === env.name} />
      </form>
    </Modal>
  );
}
