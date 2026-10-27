import { useState } from "react";
import QRCode from "qrcode";
import type { Capability } from "@server/shared/capabilities";
import type { RemotePairing } from "@server/shared/contract-remote";
import { DialogFooter, ErrorLine, errorText } from "../../../../chrome/ConfirmDialog";
import { Modal } from "../../../../chrome/Modal";
import { capsText } from "../../../../lib/hostConnection";
import { Input } from "../../../settingsBits";
import { CopyButton } from "../CopyButton";
import { rpc } from "../rpc";
import { CapsPicker, Countdown, FIELD, Secret } from "./fields";

type Pairing = { pairing: RemotePairing; code: string; url: string };

export function PairDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [caps, setCaps] = useState<Capability[]>(["operate"]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<Pairing | null>(null);
  const [qr, setQr] = useState<string | null>(null);

  const create = async () => {
    setPending(true);
    setError(null);
    try {
      const next = await rpc<Pairing>("remote.pairings.create", { name: name.trim(), audience: "client", caps });
      setMade(next);
      setQr(await QRCode.toDataURL(next.url, { margin: 1, width: 192, color: { dark: "#000000", light: "#ffffff" } }));
      await onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
    }
  };
  const cancel = async () => {
    if (made) await rpc("remote.pairings.revoke", { id: made.pairing.id }).catch(() => undefined);
    await onChanged();
    onClose();
  };

  return (
    <Modal onClose={onClose} busy={pending} title="Pair a device" size="sm">
      {made ? (
        <>
          <div className="flex flex-col gap-3 px-4 py-3">
            <div className="flex items-start gap-4">
              {qr ? <img src={qr} alt="Pairing QR code" className="size-32 shrink-0 rounded-md bg-white p-1" /> : null}
              <div className="flex min-w-0 flex-1 flex-col gap-3">
                <div className={FIELD}>
                  Code
                  <div className="flex items-center gap-1">
                    <code className="text-[18px] tracking-[0.12em] text-content">{made.code}</code>
                    <CopyButton text={made.code} label="Copy code" />
                  </div>
                </div>
                <div className="text-[12px] text-content/50">
                  <Countdown prefix={`${capsText(made.pairing.caps)} · expires in`} at={made.pairing.expiresAt} />
                </div>
              </div>
            </div>
            <Secret label="Link" value={made.url} />
          </div>
          <DialogFooter onCancel={() => void cancel()} confirmLabel="Done" onConfirm={onClose} />
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <div className="flex flex-col gap-3 px-4 py-3">
            <label className={FIELD}>
              Name
              <Input value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="iPhone" />
            </label>
            <div className={FIELD}>
              May
              <CapsPicker value={caps} audience="client" onChange={setCaps} />
            </div>
            <ErrorLine error={error} />
          </div>
          <DialogFooter onCancel={onClose} confirmLabel="Create code" pending={pending} disabled={!name.trim()} />
        </form>
      )}
    </Modal>
  );
}
