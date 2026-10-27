import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { RemoteKey, RemotePairing, RemoteSession, RemoteStatus } from "@server/shared/contract-remote";
import type { HarnessSyncStatus } from "@server/shared/contract-harness";
import type { MemorySyncStatus } from "@server/shared/contract-memory";
import type { AttachmentSettings } from "@server/shared/contract-attachments";
import { forgetAttachmentSettings } from "../lib/attachmentUpload";
import { ErrorLine, errorText } from "../chrome/ConfirmDialog";
import { DeployDriftMark } from "../chrome/DeployDrift";
import { timeAgo } from "../lib/format";
import { LOCAL_ENVIRONMENT_ID, registry } from "../lib/connection";
import { Heading, Input, Row, SecondaryButton, Toggle } from "./settingsBits";
import { capsText } from "../lib/hostConnection";
import { CopyButton } from "./settings/hosts/CopyButton";
import { Countdown } from "./settings/hosts/dialogs/fields";
import { NewKeyDialog } from "./settings/hosts/dialogs/NewKeyDialog";
import { PairDialog } from "./settings/hosts/dialogs/PairDialog";
import { MatrixSpinner } from "./threads/bits";
import { harnessParts } from "./harnessLine";
import { memoryParts } from "./memoryLine";
import { isWebMode } from "../lib/nativeWeb";
import { revealPath } from "../lib/fs";
import { MacBridgeSettings } from "./MacBridgeSettings";
import { DeploySettings } from "./DeploySettings";
import { AdmissionSettings } from "./AdmissionSettings";

/**
 * Settings → Remote access (plan 5jtfkIC45Cbr): the environment id, the
 * fixed-port listener, the pairing-link origin, every client that may reach
 * this server (phones, bots, browsers) and the browser sessions. Keys and
 * pairings are made in modals; a secret is shown once, in the response.
 */

const kindText = (key: RemoteKey): string =>
  key.audience === "mcp" ? "Bot (MCP)" : key.kind === "browser" ? "Browser" : "Key";

const rpc = <T,>(method: string, params: unknown = {}): Promise<T> => registry.primary().request<T>(method, params);

export function RemoteSettings({ onOpenSession }: { onOpenSession?: (sessionId: string) => void } = {}) {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [keys, setKeys] = useState<RemoteKey[]>([]);
  const [pairings, setPairings] = useState<RemotePairing[]>([]);
  const [sessions, setSessions] = useState<RemoteSession[]>([]);
  const [harness, setHarness] = useState<HarnessSyncStatus | null>(null);
  const [memory, setMemory] = useState<MemorySyncStatus | null>(null);
  const [showConflicts, setShowConflicts] = useState(false);
  const [attachments, setAttachments] = useState<AttachmentSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"key" | "pair" | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, k, p, b, h, mem, a] = await Promise.all([
        rpc<RemoteStatus>("remote.status"),
        rpc<RemoteKey[]>("remote.keys.list"),
        rpc<RemotePairing[]>("remote.pairings.list"),
        rpc<RemoteSession[]>("remote.sessions.list"),
        // An older host without the harness sync answers an error: the section just stays away.
        rpc<HarnessSyncStatus>("harness.status").catch(() => null),
        rpc<MemorySyncStatus>("memory.status").catch(() => null),
        rpc<AttachmentSettings>("attachment.settings", {}).catch(() => null),
      ]);
      setStatus(s);
      setKeys(k);
      setPairings(p);
      setSessions(b);
      setHarness(h);
      setMemory(mem);
      setAttachments(a);
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
  /** Sync now on a host runs whichever legs are on: the harness config out, the memory both ways. */
  const syncHost = useCallback(
    async (environmentId: string, harnessOn: boolean, memoryOn: boolean) => {
      try {
        if (harnessOn) await rpc("harness.sync", { environmentId });
        if (memoryOn) await rpc("memory.sync", { environmentId });
        await refresh();
      } catch (err) {
        setError(errorText(err));
      }
    },
    [refresh],
  );

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
        <DeployDriftMark environmentId={LOCAL_ENVIRONMENT_ID} />
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
      {attachments ? (
        <Row
          label="Attachment limit"
          description="Largest file, in MB, a thread on this machine takes as an upload or a paste. Files from another host are copied here first."
        >
          <MegabytesField
            value={Math.round(attachments.maxBytes / 1024 / 1024)}
            onCommit={(mb) => {
              forgetAttachmentSettings();
              void act("attachment.settings.set", { maxBytes: mb * 1024 * 1024 });
            }}
          />
        </Row>
      ) : null}
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
            description="Skills, commands, agents, hooks, settings and plugins of Claude Code and Codex go from here to every host this machine holds an admin key for; this machine's copy wins. A skill's per-platform binary stays: each host downloads its own."
          >
            <Toggle
              label="Sync harness config"
              on={harness.enabled}
              onChange={(on) => void act("harness.settings.set", { enabled: on })}
            />
          </Row>
          {memory ? (
            <Row
              label="Sync memory"
              description="Claude Code's per-project memory and plans and Codex's memories cross both ways with every host paired here. The newer copy wins; the other is kept beside it as a conflict copy."
            >
              <Toggle
                label="Sync memory"
                on={memory.enabled}
                onChange={(on) => void act("memory.settings.set", { enabled: on })}
              />
            </Row>
          ) : null}
          <List empty="No host to sync to: pair one with an admin key in Settings → Environments.">
            {harness.environments.map((env) => {
              const mem = memory?.environments.find((m) => m.id === env.id) ?? null;
              const running = env.running || mem?.running === true;
              return (
                <Item
                  key={env.id}
                  title={env.name}
                  meta={
                    mem ? (
                      <>
                        <div className="truncate">{harnessParts(env).join(" · ")}</div>
                        <div className="truncate">
                          {memoryParts(mem).join(" · ")}
                          {mem.conflicts > 0 || (memory?.conflicts.length ?? 0) > 0 ? (
                            <>
                              {" · "}
                              <button
                                type="button"
                                className="text-content/70 underline decoration-content/20 underline-offset-2 hover:text-content"
                                onClick={() => setShowConflicts((v) => !v)}
                              >
                                {showConflicts ? "Hide conflict copies" : "Show conflict copies"}
                              </button>
                            </>
                          ) : null}
                        </div>
                      </>
                    ) : (
                      harnessParts(env).join(" · ")
                    )
                  }
                  action={
                    <SecondaryButton
                      disabled={(!harness.enabled && !(memory?.enabled ?? false)) || !env.connected || running}
                      onClick={() => void syncHost(env.id, harness.enabled, memory?.enabled ?? false)}
                    >
                      Sync now
                    </SecondaryButton>
                  }
                />
              );
            })}
          </List>
          {harness.skipped > 0 ? (
            <p className="pb-2 text-[12px] text-content/40">
              {harness.skipped} {harness.skipped === 1 ? "file stays" : "files stay"} on this machine (over 16 MB, a symlink out of reach, or a macOS binary).
            </p>
          ) : null}
          {memory && showConflicts && memory.conflicts.length > 0 ? (
            <>
              <p className="pt-3 pb-1 text-[12px] text-content/40">
                {memory.conflicts.length === 1 ? "One conflict copy" : `${memory.conflicts.length} conflict copies`} on this machine: each sits beside the file that won. Merge what you need into it, then delete the copy; the deletion reaches the other host.
              </p>
              <List empty="No conflict copies.">
                {memory.conflicts.map((c) => (
                  <Item
                    key={c.path}
                    title={c.of}
                    meta={`${c.host}'s copy, ${timeAgo(c.at) === "now" ? "just now" : `${timeAgo(c.at)} ago`} · ${c.path}`}
                    action={
                      isWebMode() ? null : (
                        <SecondaryButton onClick={() => void revealPath(c.path)}>Reveal</SecondaryButton>
                      )
                    }
                  />
                ))}
              </List>
            </>
          ) : null}
        </>
      ) : null}

      <AdmissionSettings />

      <DeploySettings />

      <MacBridgeSettings onOpenSession={onOpenSession} />

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

function MegabytesField({ value, onCommit }: { value: number; onCommit: (mb: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const mb = Number(text);
    if (Number.isInteger(mb) && mb > 0 && mb <= 100_000 && mb !== value) onCommit(mb);
    else setText(String(value));
  };
  return (
    <Input
      aria-label="Attachment limit in MB"
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

