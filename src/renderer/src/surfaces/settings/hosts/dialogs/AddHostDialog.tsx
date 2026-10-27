import { useState } from "react";
import type { SavedEnvironment } from "@server/shared/contract-remote";
import { Input } from "@renderer/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@renderer/components/ui/toggle-group";
import { DialogFooter, ErrorLine } from "../../../../chrome/ConfirmDialog";
import { Field, FieldRow } from "../../../../chrome/DialogField";
import { Modal, useModalClose } from "../../../../chrome/Modal";
import { hostErrorText } from "../../../../lib/hostConnection";
import { rpc } from "../rpc";

type Props = { repair?: SavedEnvironment; onClose: () => void; onChanged: () => Promise<void> };

export function AddHostDialog(props: Props) {
  const [pending, setPending] = useState(false);
  return (
    <Modal onClose={props.onClose} busy={pending} title={props.repair ? `Pair ${props.repair.name} again` : "Add environment"} size="sm">
      <Body {...props} pending={pending} setPending={setPending} />
    </Modal>
  );
}

function Body({ repair, onClose, onChanged, pending, setPending }: Props & { pending: boolean; setPending: (on: boolean) => void }) {
  const close = useModalClose();
  const [mode, setMode] = useState<"link" | "key">("link");
  const [link, setLink] = useState("");
  const [origin, setOrigin] = useState(repair ? originOf(repair.routes[0]?.url ?? "") : "");
  const [key, setKey] = useState("");
  const [name, setName] = useState(repair?.name ?? "");
  const [error, setError] = useState<string | null>(null);

  const ready = mode === "link" ? link.trim().length > 0 : origin.trim().length > 0 && key.trim().length > 0;
  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      const named = name.trim() ? { name: name.trim() } : {};
      const added =
        mode === "link"
          ? await rpc<SavedEnvironment>("remote.environments.pair", { link: link.trim(), ...named })
          : await rpc<SavedEnvironment>("remote.environments.add", { url: origin.trim(), key: key.trim(), ...named });
      if (repair && added.id !== repair.id) {
        setError(`That link belongs to another host (${added.name}), which is now added too.`);
        await onChanged();
        setPending(false);
        return;
      }
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
      <div className="flex flex-col gap-4 px-5 py-4">
        <FieldRow label="With">
          <ToggleGroup spacing={0} size="sm" value={[mode]} onValueChange={(next) => next[0] && setMode(next[0] as "link" | "key")}>
            <ToggleGroupItem value="link">Pairing link</ToggleGroupItem>
            <ToggleGroupItem value="key">Key</ToggleGroupItem>
          </ToggleGroup>
        </FieldRow>
        {mode === "link" ? (
          <Field label="Pairing link">
            <Input
              value={link}
              autoFocus
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://host/pair#ABCDE-12345"
              spellCheck={false}
              autoComplete="off"
              data-environment-field="link"
            />
          </Field>
        ) : (
          <>
            <Field label="Host">
              <Input
                value={origin}
                autoFocus
                onChange={(e) => setOrigin(e.target.value)}
                placeholder="https://tempcode.example.com"
                spellCheck={false}
                autoComplete="off"
                data-environment-field="origin"
              />
            </Field>
            <Field label="Key">
              <Input
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="tc_…"
                spellCheck={false}
                autoComplete="off"
                type="password"
                data-environment-field="key"
              />
            </Field>
          </>
        )}
        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="the host's own name when empty"
            spellCheck={false}
            autoComplete="off"
            data-environment-field="name"
          />
        </Field>
        <ErrorLine error={error} />
      </div>
      <DialogFooter onCancel={onClose} confirmLabel={repair ? "Pair" : "Add"} pending={pending} disabled={!ready} />
    </form>
  );
}

/** `wss://host/ws` → `https://host`, the form the Host field takes. */
function originOf(url: string): string {
  try {
    const u = new URL(url);
    u.protocol = u.protocol === "wss:" ? "https:" : "http:";
    return u.origin;
  } catch {
    return "";
  }
}
