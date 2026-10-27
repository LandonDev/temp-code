import { useState } from "react";
import type { SavedEnvironment } from "@server/shared/contract-remote";
import { Input } from "@renderer/components/ui/input";
import { DialogFooter, ErrorLine } from "../../../../chrome/ConfirmDialog";
import { Field } from "../../../../chrome/DialogField";
import { Modal, useModalClose } from "../../../../chrome/Modal";
import { hostErrorText } from "../../../../lib/hostConnection";
import { rpc } from "../rpc";

type Props = { env: SavedEnvironment; onClose: () => void; onChanged: () => Promise<void> };

export function RenameHostDialog(props: Props) {
  const [pending, setPending] = useState(false);
  return (
    <Modal onClose={props.onClose} busy={pending} title={`Rename ${props.env.name}`} size="sm">
      <Body {...props} pending={pending} setPending={setPending} />
    </Modal>
  );
}

function Body({ env, onClose, onChanged, pending, setPending }: Props & { pending: boolean; setPending: (on: boolean) => void }) {
  const close = useModalClose();
  const [name, setName] = useState(env.name);
  const [error, setError] = useState<string | null>(null);
  const ready = !!name.trim() && name.trim() !== env.name;
  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      await rpc("remote.environments.update", { id: env.id, name: name.trim() });
      await onChanged();
      setPending(false);
      if (close) close(onClose);
      else onClose();
    } catch (err) {
      setError(hostErrorText(err));
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
      <div className="flex flex-col gap-4 px-4 py-4">
        <Field label="Name">
          <Input
            value={name}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setName(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            data-environment-field="rename"
          />
        </Field>
        <ErrorLine error={error} />
      </div>
      <DialogFooter onCancel={onClose} confirmLabel="Rename" pending={pending} disabled={!ready} />
    </form>
  );
}
