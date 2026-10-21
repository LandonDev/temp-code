import { useCallback, useEffect, useState, type ReactNode } from "react";
import QRCode from "qrcode";
import type { Capability } from "@server/shared/capabilities";
import type {
  RemoteAudience,
  RemoteKey,
  RemotePairing,
  RemoteSession,
  RemoteStatus,
} from "@server/shared/contract-remote";
import type { HarnessSyncStatus } from "@server/shared/contract-harness";
import { DialogFooter, ErrorLine, errorText } from "../chrome/ConfirmDialog";
import { Check, Copy } from "../chrome/icons";
import { Modal } from "../chrome/Modal";
import { timeAgo } from "../lib/format";
import { registry } from "../lib/connection";
import { Heading, INPUT_CLASS, Input, Row, SecondaryButton, Segmented, Toggle } from "./settingsBits";
import { MatrixSpinner } from "./threads/bits";
import { harnessLine } from "./harnessLine";

/**
 * Settings → Remote access (plan 5jtfkIC45Cbr): the environment id, the
 * fixed-port listener, the pairing-link origin, every client that may reach
 * this server (phones, bots, browsers) and the browser sessions. Keys and
 * pairings are made in modals; a secret is shown once, in the response.
 */

const GRANTABLE: { cap: Capability; label: string }[] = [
  { cap: "operate", label: "Operate" },
  { cap: "approve", label: "Approve" },
  { cap: "admin", label: "Admin" },
];

const capsText = (caps: Capability[]): string => {
  const granted = GRANTABLE.filter(({ cap }) => caps.includes(cap)).map(({ cap }) => cap);
  return granted.length === 0 ? "read only" : granted.join(", ");
};
const kindText = (key: RemoteKey): string =>
  key.audience === "mcp" ? "Bot (MCP)" : key.kind === "browser" ? "Browser" : "Key";

const rpc = <T,>(method: string, params: unknown = {}): Promise<T> => registry.primary().request<T>(method, params);

export function RemoteSettings() {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [keys, setKeys] = useState<RemoteKey[]>([]);
  const [pairings, setPairings] = useState<RemotePairing[]>([]);
  const [sessions, setSessions] = useState<RemoteSession[]>([]);
  const [harness, setHarness] = useState<HarnessSyncStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"key" | "pair" | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, k, p, b, h] = await Promise.all([
        rpc<RemoteStatus>("remote.status"),
        rpc<RemoteKey[]>("remote.keys.list"),
        rpc<RemotePairing[]>("remote.pairings.list"),
        rpc<RemoteSession[]>("remote.sessions.list"),
        // An older host without the harness sync answers an error: the section just stays away.
        rpc<HarnessSyncStatus>("harness.status").catch(() => null),
      ]);
      setStatus(s);
      setKeys(k);
      setPairings(p);
      setSessions(b);
      setHarness(h);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);
  // A phone pairing or a browser signing in shows up without a click.
  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(t);
  }, [refresh]);

  const act = useCallback(
    async (method: string, params: unknown) => {
      try {
        await rpc(method, params);
        await refresh();
      } catch (err) {
        setError(errorText(err));
      }
    },
    [refresh],
  );
  const setSettings = (patch: { enabled?: boolean; port?: number; publicOrigin?: string; stuckMinutes?: number }) =>
    act("remote.settings.set", patch);

  if (!status) {
    return (
      <div className="flex justify-center py-10">
        <MatrixSpinner cell={2} />
      </div>
    );
  }

  const overridden = status.running && status.port !== status.configuredPort;
  const listenerLine = status.running
    ? `Listening on 127.0.0.1:${status.port}${overridden ? ` (TEMP_CODE_REMOTE_PORT overrides the setting)` : ""}`
    : status.error
      ? status.error
      : status.enabled
        ? "Off (TEMP_CODE_REMOTE_PORT=0)"
        : "Off";

  return (
    <>
      <Row label="Environment" description="Clients check this id before trusting a route.">
        <code className="text-[12px] text-content/70">{status.environmentId}</code>
        <CopyButton text={status.environmentId} label="Copy environment id" />
      </Row>
      <Row label="Listener" description={listenerLine}>
        <PortField value={status.configuredPort} onCommit={(port) => void setSettings({ port })} />
        <Toggle label="Remote access" on={status.enabled} onChange={(on) => void setSettings({ enabled: on })} />
      </Row>
      <Row
        label="Public origin"
        description={
          status.publicOrigin
            ? "Pairing links start with this."
            : `Pairing links start with ${status.origin}${status.learnedOrigin ? ", learned from the tunnel" : ""}.`
        }
      >
        <TextField
          value={status.publicOrigin}
          placeholder="https://tempcode.example.com"
          label="Public origin"
          onCommit={(publicOrigin) => void setSettings({ publicOrigin })}
        />
      </Row>
      <Row label="Stuck after" description="Minutes a working thread may stay silent before bots and the hub hear it is stuck.">
        <MinutesField value={status.stuckMinutes} onCommit={(stuckMinutes) => void setSettings({ stuckMinutes })} />
      </Row>
      <ErrorLine error={error} />

      <Heading title="Clients" />
      <div className="flex items-center gap-2 py-2">
        <SecondaryButton onClick={() => setDialog("pair")}>Pair a device</SecondaryButton>
        <SecondaryButton onClick={() => setDialog("key")}>New key</SecondaryButton>
      </div>
      <List empty="No clients yet.">
        {pairings.map((p) => (
          <Item
            key={p.id}
            title={p.name}
            meta={<Countdown prefix={`pairing code · ${capsText(p.caps)} · expires in`} at={p.expiresAt} />}
            action={<SecondaryButton onClick={() => void act("remote.pairings.revoke", { id: p.id })}>Cancel</SecondaryButton>}
          />
        ))}
        {keys.map((k) => (
          <Item
            key={k.id}
            title={k.name}
            meta={`${kindText(k)} · ${capsText(k.caps)}${k.webhookUrl ? ` · webhook ${hostOf(k.webhookUrl)}` : ""} · ${k.lastUsedAt ? `used ${timeAgo(k.lastUsedAt)}` : "never used"}`}
            action={
              <SecondaryButton danger onClick={() => void act("remote.keys.revoke", { id: k.id })}>
                Revoke
              </SecondaryButton>
            }
          />
        ))}
      </List>

      {harness ? (
        <>
          <Heading title="Harness config" />
          <Row
            label="Sync to hosts"
            description="Skills, commands, agents, settings and plugins of Claude Code and Codex go from here to every host this machine holds an admin key for; this machine's copy wins."
          >
            <Toggle
              label="Sync harness config"
              on={harness.enabled}
              onChange={(on) => void act("harness.settings.set", { enabled: on })}
            />
          </Row>
          <List empty="No host to sync to: pair one with an admin key in Settings → Environments.">
            {harness.environments.map((env) => (
              <Item
                key={env.id}
                title={env.name}
                meta={harnessLine(env)}
                action={
                  <SecondaryButton
                    disabled={!harness.enabled || !env.connected || env.running}
                    onClick={() => void act("harness.sync", { environmentId: env.id })}
                  >
                    Sync now
                  </SecondaryButton>
                }
              />
            ))}
          </List>
          {harness.skipped > 0 ? (
            <p className="pb-2 text-[12px] text-content/40">
              {harness.skipped} {harness.skipped === 1 ? "file stays" : "files stay"} on this machine (over 16 MB, or a symlink out of reach).
            </p>
          ) : null}
        </>
      ) : null}

      <Heading title="Browser sessions" />
      <List empty="No browser is signed in.">
        {sessions.map((s) => (
          <Item
            key={s.id}
            title={s.keyName}
            meta={`${capsText(s.caps)} · seen ${timeAgo(s.lastSeenAt)}${s.userAgent ? ` · ${shortAgent(s.userAgent)}` : ""}`}
            action={
              <SecondaryButton danger onClick={() => void act("remote.sessions.revoke", { id: s.id })}>
                Sign out
              </SecondaryButton>
            }
          />
        ))}
      </List>

      {dialog === "key" ? <NewKeyDialog onClose={() => setDialog(null)} onChanged={refresh} /> : null}
      {dialog === "pair" ? <PairDialog onClose={() => setDialog(null)} onChanged={refresh} /> : null}
    </>
  );
}

// ── pieces ─────────────────────────────────────────────────────────────────

function List({ empty, children }: { empty: string; children: ReactNode[] }) {
  const items = children.flat().filter(Boolean);
  if (items.length === 0) return <p className="py-3 text-[12px] text-content/40">{empty}</p>;
  return <div className="flex flex-col">{items}</div>;
}

function Item({ title, meta, action }: { title: string; meta: ReactNode; action: ReactNode }) {
  return (
    <div className="flex items-center gap-6 border-b border-content/5 py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-content">{title}</div>
        <div className="mt-0.5 truncate text-[12px] text-content/40">{meta}</div>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}

function shortAgent(ua: string): string {
  const m = /(Edg|OPR|Chrome|Firefox|Safari|CriOS)\/[\d.]+/.exec(ua);
  return m ? m[0].split("/")[0].replace("CriOS", "Chrome").replace("OPR", "Opera").replace("Edg", "Edge") : "";
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}
      className="pressable grid size-7 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content"
    >
      {copied ? <Check className="size-3.5" strokeWidth={2.25} /> : <Copy className="size-3.5" strokeWidth={1.75} />}
    </button>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function MinutesField({ value, onCommit }: { value: number; onCommit: (minutes: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const minutes = Number(text);
    if (Number.isInteger(minutes) && minutes > 0 && minutes <= 1440 && minutes !== value) onCommit(minutes);
    else setText(String(value));
  };
  return (
    <Input
      aria-label="Stuck after minutes"
      inputMode="numeric"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      className="w-20 text-right"
    />
  );
}

function PortField({ value, onCommit }: { value: number; onCommit: (port: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const port = Number(text);
    if (Number.isInteger(port) && port > 0 && port < 65536 && port !== value) onCommit(port);
    else setText(String(value));
  };
  return (
    <Input
      aria-label="Port"
      inputMode="numeric"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      className="w-20 text-right"
    />
  );
}

function TextField({
  value,
  placeholder,
  label,
  onCommit,
}: {
  value: string;
  placeholder: string;
  label: string;
  onCommit: (value: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <Input
      aria-label={label}
      value={text}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text.trim() !== value) onCommit(text.trim());
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      className="w-64"
    />
  );
}

function Countdown({ prefix, at }: { prefix: string; at: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const left = Math.max(0, Math.round((at - now) / 1000));
  return (
    <>
      {prefix} {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
    </>
  );
}

function CapsPicker({
  value,
  audience,
  onChange,
}: {
  value: Capability[];
  audience: RemoteAudience;
  onChange: (caps: Capability[]) => void;
}) {
  return (
    <div className="flex gap-0.5 rounded-md border border-content/10 p-0.5 text-[12px]" role="group" aria-label="Capabilities">
      {GRANTABLE.map(({ cap, label }) => {
        const on = value.includes(cap);
        const blocked = audience === "mcp" && cap !== "operate";
        return (
          <button
            key={cap}
            type="button"
            role="checkbox"
            aria-checked={on}
            disabled={blocked}
            title={blocked ? "Bots never approve or administer" : undefined}
            onClick={() => onChange(on ? value.filter((c) => c !== cap) : [...value, cap])}
            className={`pressable rounded-[4px] px-3 py-1 disabled:cursor-default disabled:opacity-30 ${
              on ? "bg-content/10 text-content" : "text-content/50 hover:text-content"
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

const FIELD = "flex flex-col gap-1.5 text-[12px] text-content/50";

function Secret({ label, value }: { label: string; value: string }) {
  return (
    <div className={FIELD}>
      {label}
      <div className="flex items-center gap-1">
        <code className={`${INPUT_CLASS} min-w-0 flex-1 select-all break-all`}>{value}</code>
        <CopyButton text={value} label={`Copy ${label.toLowerCase()}`} />
      </div>
    </div>
  );
}

function NewKeyDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => Promise<void> }) {
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

type Pairing = { pairing: RemotePairing; code: string; url: string };

function PairDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => Promise<void> }) {
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
