import { useState } from "react";
import type { SavedEnvironment } from "@server/shared/contract-remote";
import { DialogFooter, ErrorLine } from "../../../../chrome/ConfirmDialog";
import { Modal } from "../../../../chrome/Modal";
import { hostErrorText } from "../../../../lib/hostConnection";
import { Input, Segmented } from "../../../settingsBits";
import { rpc } from "../rpc";
import { FIELD } from "./fields";

export function AddHostDialog({ repair, onClose, onChanged }: { repair?: SavedEnvironment; onClose: () => void; onChanged: () => Promise<void> }) {
  const [mode, setMode] = useState<"link" | "key">("link");
  const [link, setLink] = useState("");
  const [origin, setOrigin] = useState(repair ? originOf(repair.routes[0]?.url ?? "") : "");
  const [key, setKey] = useState("");
  const [name, setName] = useState(repair?.name ?? "");
  const [pending, setPending] = useState(false);
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
      onClose();
    } catch (err) {
      setError(hostErrorText(err));
      setPending(false);
    }
  };

  return (
    <Modal onClose={onClose} busy={pending} title={repair ? `Pair ${repair.name} again` : "Add environment"} size="sm">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void submit();
        }}
      >
        <div className="flex flex-col gap-3 px-4 py-3">
          <div className={FIELD}>
            With
            <Segmented
              label="How"
              value={mode}
              options={[
                { value: "link", label: "Pairing link" },
                { value: "key", label: "Key" },
              ]}
              onChange={setMode}
            />
          </div>
          {mode === "link" ? (
            <label className={FIELD}>
              Pairing link
              <Input
                value={link}
                autoFocus
                onChange={(e) => setLink(e.target.value)}
                placeholder="https://host/pair#ABCDE-12345"
                spellCheck={false}
                autoComplete="off"
                data-environment-field="link"
              />
            </label>
          ) : (
            <>
              <label className={FIELD}>
                Host
                <Input
                  value={origin}
                  autoFocus
                  onChange={(e) => setOrigin(e.target.value)}
                  placeholder="https://tempcode.example.com"
                  spellCheck={false}
                  autoComplete="off"
                  data-environment-field="origin"
                />
              </label>
              <label className={FIELD}>
                Key
                <Input
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="tc_…"
                  spellCheck={false}
                  autoComplete="off"
                  type="password"
                  data-environment-field="key"
                />
              </label>
            </>
          )}
          <label className={FIELD}>
            Name
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="the host's own name when empty"
              spellCheck={false}
              autoComplete="off"
              data-environment-field="name"
            />
          </label>
          <ErrorLine error={error} />
        </div>
        <DialogFooter onCancel={onClose} confirmLabel={repair ? "Pair" : "Add"} pending={pending} disabled={!ready} />
      </form>
    </Modal>
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
