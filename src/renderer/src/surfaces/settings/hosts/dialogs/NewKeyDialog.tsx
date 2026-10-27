import { useState } from "react";
import type { Capability } from "@server/shared/capabilities";
import type { RemoteAudience, RemoteKey } from "@server/shared/contract-remote";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@renderer/components/ui/toggle-group";
import { DialogFooter, ErrorLine, errorText } from "../../../../chrome/ConfirmDialog";
import { Field, FieldRow } from "../../../../chrome/DialogField";
import { Modal, useModalClose } from "../../../../chrome/Modal";
import { rpc } from "../rpc";
import { CapsPicker, Secret } from "./fields";

type Created = { key: RemoteKey; token: string; webhookSecret?: string };
type Props = { onClose: () => void; onChanged: () => Promise<void> };

export function NewKeyDialog(props: Props) {
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  return (
    <Modal
      onClose={props.onClose}
      busy={pending}
      title={created ? "Key created" : "New key"}
      description={created ? "Copy it now. It is not shown again." : undefined}
      size="sm"
    >
      {created ? <Made created={created} onClose={props.onClose} /> : <Form {...props} pending={pending} setPending={setPending} onCreated={setCreated} />}
    </Modal>
  );
}

function Made({ created, onClose }: { created: Created; onClose: () => void }) {
  const close = useModalClose();
  return (
    <>
      <div className="flex flex-col gap-4 px-5 py-4">
        <Secret label="Key" value={created.token} />
        {created.webhookSecret ? <Secret label="Webhook signing secret" value={created.webhookSecret} /> : null}
      </div>
      {/* Nothing is left to cancel once the key exists: Done alone. */}
      <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
        <Button onClick={() => (close ? close(onClose) : onClose())}>Done</Button>
      </div>
    </>
  );
}

function Form({
  onClose,
  onChanged,
  pending,
  setPending,
  onCreated,
}: Props & { pending: boolean; setPending: (on: boolean) => void; onCreated: (made: Created) => void }) {
  const [name, setName] = useState("");
  const [audience, setAudience] = useState<RemoteAudience>("client");
  const [caps, setCaps] = useState<Capability[]>(["operate"]);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setPending(true);
    setError(null);
    try {
      const url = webhookUrl.trim();
      const secret = webhookSecret.trim();
      const made = await rpc<Created>("remote.keys.create", {
        name: name.trim(),
        audience,
        caps,
        ...(url ? { webhookUrl: url } : {}),
        ...(url && secret ? { webhookSecret: secret } : {}),
      });
      onCreated(made);
      await onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
    }
  };
  const pickAudience = (next: RemoteAudience) => {
    setAudience(next);
    if (next === "mcp") setCaps((c) => c.filter((cap) => cap === "operate"));
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) void create();
      }}
    >
      <div className="flex flex-col gap-4 px-5 py-4">
        <Field label="Name">
          <Input value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder={audience === "mcp" ? "grok" : "iphone"} />
        </Field>
        <div className="flex flex-col">
          <FieldRow label="For">
            <ToggleGroup spacing={0} size="sm" value={[audience]} onValueChange={(next) => next[0] && pickAudience(next[0] as RemoteAudience)}>
              <ToggleGroupItem value="client">App</ToggleGroupItem>
              <ToggleGroupItem value="mcp">Bot (MCP)</ToggleGroupItem>
            </ToggleGroup>
          </FieldRow>
          <FieldRow label="May">
            <CapsPicker value={caps} audience={audience} onChange={setCaps} />
          </FieldRow>
        </div>
        <Field label="Webhook URL">
          <Input
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
            placeholder="https://bot.example.com/hook (optional)"
            spellCheck={false}
            autoComplete="off"
          />
        </Field>
        {webhookUrl.trim() ? (
          <Field label="Signing secret">
            <Input
              value={webhookSecret}
              onChange={(e) => setWebhookSecret(e.target.value)}
              placeholder="generated when empty"
              spellCheck={false}
              autoComplete="off"
            />
          </Field>
        ) : null}
        <ErrorLine error={error} />
      </div>
      <DialogFooter onCancel={onClose} confirmLabel="Create" pending={pending} disabled={!name.trim()} />
    </form>
  );
}
