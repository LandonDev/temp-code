import { useState } from "react";
import QRCode from "qrcode";
import type { Capability } from "@server/shared/capabilities";
import type { RemotePairing } from "@server/shared/contract-remote";
import { Input } from "@renderer/components/ui/input";
import { DialogFooter, ErrorLine, errorText } from "../../../../chrome/ConfirmDialog";
import { Field, FieldRow } from "../../../../chrome/DialogField";
import { Modal, useModalClose } from "../../../../chrome/Modal";
import { CopyButton } from "../CopyButton";
import { rpc } from "../rpc";
import { CapsPicker, Countdown, Secret, grantText } from "./fields";

type Pairing = { pairing: RemotePairing; code: string; url: string };
type Made = Pairing & { qr: string | null };
type Props = { onClose: () => void; onChanged: () => Promise<void> };

export function PairDialog(props: Props) {
  const [pending, setPending] = useState(false);
  const [made, setMade] = useState<Made | null>(null);
  return (
    <Modal onClose={props.onClose} busy={pending} title="Pair a device" size="sm">
      {made ? <Code made={made} {...props} /> : <Form {...props} pending={pending} setPending={setPending} onMade={setMade} />}
    </Modal>
  );
}

/** Step two: the code, its QR and the link, live until it expires. */
function Code({ made, onClose, onChanged }: Props & { made: Made }) {
  const close = useModalClose();
  // Cancel takes the code back; Done keeps it for the device to redeem.
  const cancel = async () => {
    await rpc("remote.pairings.revoke", { id: made.pairing.id }).catch(() => undefined);
    await onChanged();
    onClose();
  };
  return (
    <>
      <div className="flex flex-col gap-4 px-4 py-4">
        <div className="flex items-center gap-4">
          {made.qr ? <img src={made.qr} alt="Pairing QR code" className="size-32 shrink-0 rounded-lg outline outline-1 outline-foreground/10" /> : null}
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Code</span>
            <div className="flex items-center gap-1">
              <code data-pairing-code className="font-mono text-lg tabular-nums text-foreground">
                {made.code}
              </code>
              <CopyButton text={made.code} label="Copy code" />
            </div>
            <p className="flex flex-wrap gap-x-2 text-xs tabular-nums text-muted-foreground">
              <span>{grantText(made.pairing.caps)}</span>
              <span>
                <Countdown prefix="expires in" at={made.pairing.expiresAt} />
              </span>
            </p>
          </div>
        </div>
        <Secret label="Link" value={made.url} />
      </div>
      <DialogFooter onCancel={() => void cancel()} confirmLabel="Done" onConfirm={() => (close ? close(onClose) : onClose())} />
    </>
  );
}

function Form({ onClose, onChanged, pending, setPending, onMade }: Props & { pending: boolean; setPending: (on: boolean) => void; onMade: (made: Made) => void }) {
  const [name, setName] = useState("");
  const [caps, setCaps] = useState<Capability[]>(["operate"]);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setPending(true);
    setError(null);
    try {
      const next = await rpc<Pairing>("remote.pairings.create", { name: name.trim(), audience: "client", caps });
      const qr = await QRCode.toDataURL(next.url, { margin: 1, width: 192, color: { dark: "#000000", light: "#ffffff" } }).catch(() => null);
      onMade({ ...next, qr });
      await onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) void create();
      }}
    >
      <div className="flex flex-col gap-4 px-4 py-4">
        <Field label="Name">
          <Input value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="iPhone" />
        </Field>
        <FieldRow label="May">
          <CapsPicker value={caps} audience="client" onChange={setCaps} />
        </FieldRow>
        <ErrorLine error={error} />
      </div>
      <DialogFooter onCancel={onClose} confirmLabel="Create code" pending={pending} disabled={!name.trim()} />
    </form>
  );
}
