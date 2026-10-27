import { useState } from "react";
import type { Capability } from "@server/shared/capabilities";
import type { RemoteAudience, RemoteKey } from "@server/shared/contract-remote";
import { DialogFooter, ErrorLine, errorText } from "../../../../chrome/ConfirmDialog";
import { Modal } from "../../../../chrome/Modal";
import { Input, Segmented } from "../../../settingsBits";
import { rpc } from "../rpc";
import { CapsPicker, FIELD, Secret } from "./fields";

export function NewKeyDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [audience, setAudience] = useState<RemoteAudience>("client");
  const [caps, setCaps] = useState<Capability[]>(["operate"]);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ key: RemoteKey; token: string; webhookSecret?: string } | null>(null);

  const create = async () => {
    setPending(true);
    setError(null);
    try {
      const url = webhookUrl.trim();
      const secret = webhookSecret.trim();
      setCreated(
        await rpc<{ key: RemoteKey; token: string; webhookSecret?: string }>("remote.keys.create", {
          name: name.trim(),
          audience,
          caps,
          ...(url ? { webhookUrl: url } : {}),
          ...(url && secret ? { webhookSecret: secret } : {}),
        }),
      );
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
    <Modal onClose={onClose} busy={pending} title={created ? "Key created" : "New key"} size="sm">
      {created ? (
        <>
          <div className="flex flex-col gap-3 px-4 py-3">
            <p className="text-[12px] leading-snug text-content/50">
              Copy it now. It is not shown again.
            </p>
            <Secret label="Key" value={created.token} />
            {created.webhookSecret ? <Secret label="Webhook signing secret" value={created.webhookSecret} /> : null}
          </div>
          <DialogFooter onCancel={onClose} confirmLabel="Done" onConfirm={onClose} />
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
              <Input value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder={audience === "mcp" ? "grok" : "iphone"} />
            </label>
            <div className={FIELD}>
              For
              <Segmented
                label="Audience"
                value={audience}
                options={[
                  { value: "client", label: "App" },
                  { value: "mcp", label: "Bot (MCP)" },
                ]}
                onChange={pickAudience}
              />
            </div>
            <div className={FIELD}>
              May
              <CapsPicker value={caps} audience={audience} onChange={setCaps} />
            </div>
            <label className={FIELD}>
              Webhook URL
              <Input
                value={webhookUrl}
                onChange={(e) => setWebhookUrl(e.target.value)}
                placeholder="https://bot.example.com/hook (optional)"
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            {webhookUrl.trim() ? (
              <label className={FIELD}>
                Signing secret
                <Input
                  value={webhookSecret}
                  onChange={(e) => setWebhookSecret(e.target.value)}
                  placeholder="generated when empty"
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
            ) : null}
            <ErrorLine error={error} />
          </div>
          <DialogFooter onCancel={onClose} confirmLabel="Create" pending={pending} disabled={!name.trim()} />
        </form>
      )}
    </Modal>
  );
}
