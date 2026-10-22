import { useCallback, useEffect, useState, type MouseEvent, type ReactNode } from "react";
import type { Capability } from "@server/shared/capabilities";
import type { RouteKind, SavedEnvironment, SavedRoute } from "@server/shared/contract-remote";
import { ConfirmDialog, DialogFooter, ErrorLine, errorText } from "../chrome/ConfirmDialog";
import { ExplorerMenu, type ExplorerMenuItem } from "../chrome/ExplorerMenu";
import { ArrowDownLong, ArrowUpLong, MoreHorizontal, X } from "../chrome/icons";
import { Modal } from "../chrome/Modal";
import { timeAgo } from "../lib/format";
import {
  forgetSeen,
  registry,
  useEnvironmentStatuses,
  useEnvironments,
  useLastSeenAt,
  type Environment,
  type EnvironmentStatus,
} from "../lib/connection";
import { isWebMode } from "../lib/nativeWeb";
import { loadSavedEnvironments } from "../lib/tcserver/link";
import { environment as environmentSelection } from "../stores/environment";
import { Input, SecondaryButton, Segmented } from "./settingsBits";
import { MatrixSpinner } from "./threads/bits";

/**
 * Settings → Environments (thread K2): every machine this window can run
 * threads on. This machine is the first row; each paired host shows how it
 * is reached, whether it is connected (with the next retry), when it was
 * last seen and what its key may do. Adding verifies the host (hello,
 * environment id, contract) in the main process before anything is saved;
 * removing forgets the key here and revokes nothing there.
 */

const rpc = <T,>(method: string, params: unknown = {}): Promise<T> => registry.primary().request<T>(method, params);

const CAP_LABEL: Record<Capability, string> = { read: "read", operate: "operate", approve: "approve", admin: "admin" };

export function capsText(caps: readonly Capability[]): string {
  const granted = (["operate", "approve", "admin"] as Capability[]).filter((cap) => caps.includes(cap));
  return granted.length === 0 ? "read only" : granted.map((cap) => CAP_LABEL[cap]).join(", ");
}

/** `wss://host/ws` → `host`, `ws://127.0.0.1:7677/ws` → `127.0.0.1:7677`. */
export function originText(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The main process's `<reason>: <detail>` becomes the detail; it is already a sentence. */
export function hostErrorText(err: unknown): string {
  const text = errorText(err);
  const m = /^(unauthorized|unavailable|self|unknown-environment|unknown-route|bad-url|contract|bad-link): (.*)$/s.exec(text);
  if (!m) return text;
  return m[1] === "self" ? "That is this machine." : m[2];
}

/** `slow`: the host's answers are late (lib/connection/link.ts health). */
export function statusText(status: EnvironmentStatus, now: number, slow = false): string {
  switch (status.transport) {
    case "open":
      if (slow) return "connected, slow to answer";
      return status.fresh ? "connected" : "connected, catching up";
    case "connecting":
      return "connecting…";
    case "reconnecting": {
      const wait = status.nextRetryAt ? Math.max(0, Math.ceil((status.nextRetryAt - now) / 1000)) : 0;
      return wait > 0 ? `reconnecting, next try in ${wait} s` : "reconnecting…";
    }
    case "offline":
      return "offline";
    case "unauthorized":
      return "key refused";
  }
}

const PRIVATE_HOST = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1\]?$|localhost$|.*\.local$)/i;

/** Mirrors the main process: loopback here, lan for private names, tunnel otherwise. */
export function kindOf(input: string): RouteKind {
  let host = "";
  try {
    host = new URL(input.trim()).hostname.toLowerCase();
  } catch {
    return "tunnel";
  }
  if (host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1") return "loopback";
  return PRIVATE_HOST.test(host) ? "lan" : "tunnel";
}

type Dialog =
  | { kind: "add"; repair?: SavedEnvironment }
  | { kind: "rename"; env: SavedEnvironment }
  | { kind: "routes"; env: SavedEnvironment }
  | { kind: "remove"; env: SavedEnvironment };

export function EnvironmentsSettings() {
  const environments = useEnvironments();
  const statuses = useEnvironmentStatuses();
  const [saved, setSaved] = useState<SavedEnvironment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; env: SavedEnvironment } | null>(null);
  const now = useNow(statuses);

  const refresh = useCallback(async () => {
    try {
      setSaved(await rpc<SavedEnvironment[]>("remote.environments.list"));
      setError(null);
      await loadSavedEnvironments();
    } catch (err) {
      setError(errorText(err));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (isWebMode()) {
    return <p className="py-3 text-[12px] text-content/40">This page sees one host. Pair others from the desktop app.</p>;
  }
  if (!saved) {
    return (
      <div className="flex justify-center py-10">
        <MatrixSpinner cell={2} />
      </div>
    );
  }

  const byId = new Map(saved.map((env) => [env.id, env] as const));
  const remove = async (env: SavedEnvironment) => {
    await rpc("remote.environments.remove", { id: env.id });
    environmentSelection.forget(env.id);
    forgetSeen(env.id);
    await refresh();
  };
  const menuItems = (status: EnvironmentStatus): ExplorerMenuItem[] => [
    { kind: "item", id: "retry", label: "Retry now", disabled: status.transport === "open" },
    { kind: "item", id: "repair", label: "Pair again…" },
    { kind: "sep" },
    { kind: "item", id: "rename", label: "Rename…" },
    { kind: "item", id: "routes", label: "Routes…" },
    { kind: "sep" },
    { kind: "item", id: "remove", label: "Remove…", danger: true },
  ];

  return (
    <>
      <div className="flex flex-col">
        {environments.map((env) => {
          const status = statuses.get(env.id);
          if (!status) return null;
          const row = byId.get(env.id);
          return (
            <EnvironmentRow
              key={env.id}
              environment={env}
              saved={row ?? null}
              status={status}
              now={now}
              onRetry={() => registry.retry(env.id)}
              onRepair={row ? () => setDialog({ kind: "add", repair: row }) : undefined}
              onMenu={row ? (e) => setMenu({ x: e.clientX, y: e.clientY, env: row }) : undefined}
            />
          );
        })}
      </div>
      <ErrorLine error={error} />
      <div className="flex items-center gap-2 py-3">
        <SecondaryButton onClick={() => setDialog({ kind: "add" })}>Add environment</SecondaryButton>
      </div>

      {menu ? (
        <ExplorerMenu
          x={menu.x}
          y={menu.y}
          ariaLabel="Environment actions"
          items={menuItems(statuses.get(menu.env.id) ?? registry.statusOf(menu.env.id))}
          onClose={() => setMenu(null)}
          onPick={(id) => {
            const env = menu.env;
            setMenu(null);
            if (id === "retry") registry.retry(env.id);
            else if (id === "repair") setDialog({ kind: "add", repair: env });
            else if (id === "rename") setDialog({ kind: "rename", env });
            else if (id === "routes") setDialog({ kind: "routes", env });
            else if (id === "remove") setDialog({ kind: "remove", env });
          }}
        />
      ) : null}
      {dialog?.kind === "add" ? <AddDialog repair={dialog.repair} onClose={() => setDialog(null)} onChanged={refresh} /> : null}
      {dialog?.kind === "rename" ? <RenameDialog env={dialog.env} onClose={() => setDialog(null)} onChanged={refresh} /> : null}
      {dialog?.kind === "routes" ? <RoutesDialog env={dialog.env} onClose={() => setDialog(null)} onChanged={refresh} /> : null}
      {dialog?.kind === "remove" ? (
        <ConfirmDialog
          title={`Remove ${dialog.env.name}`}
          body="This window forgets the host and its key. Nothing changes on the host; revoke the key there to shut this window out."
          confirmLabel="Remove"
          danger
          onCancel={() => setDialog(null)}
          onConfirm={async () => {
            await remove(dialog.env);
            setDialog(null);
          }}
        />
      ) : null}
    </>
  );
}

/** A 1 s clock while any environment counts down to a retry. */
function useNow(statuses: ReadonlyMap<string, EnvironmentStatus>): number {
  const counting = [...statuses.values()].some((s) => s.nextRetryAt !== null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!counting) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [counting, statuses]);
  return now;
}

function EnvironmentRow({
  environment,
  saved,
  status,
  now,
  onRetry,
  onRepair,
  onMenu,
}: {
  environment: Environment;
  saved: SavedEnvironment | null;
  status: EnvironmentStatus;
  now: number;
  onRetry: () => void;
  onRepair?: () => void;
  onMenu?: (e: MouseEvent<HTMLButtonElement>) => void;
}) {
  const lastSeen = useLastSeenAt(environment.id);
  const live = registry.link(environment.id)?.transport?.url ?? environment.routes[status.route ?? 0]?.url ?? environment.routes[0]?.url;
  const origin = live ? originText(live) : "";
  const caps = status.lastHello?.caps ?? saved?.caps ?? [];
  const meta: string[] = [];
  if (origin) meta.push(saved ? origin : `${origin} · this machine`);
  meta.push(statusText(status, now));
  if (status.transport !== "open" && lastSeen) meta.push(`seen ${timeAgo(lastSeen, now)}`);
  if (saved) meta.push(capsText(caps));
  const tone =
    status.transport === "open"
      ? status.fresh
        ? "bg-success"
        : "bg-success/50"
      : status.transport === "unauthorized"
        ? "bg-danger"
        : status.transport === "offline"
          ? "bg-content/25"
          : "bg-warning";
  return (
    <div className="flex items-center gap-6 border-b border-content/5 py-3 last:border-b-0" data-environment-row={environment.id}>
      <span aria-hidden className={`size-2 shrink-0 rounded-full ${tone}`} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-content">{environment.name}</div>
        <div className="mt-0.5 truncate text-[12px] text-content/40" title={status.lastError ?? undefined}>
          {meta.join(" · ")}
        </div>
      </div>
      {saved ? (
        <div className="flex shrink-0 items-center gap-1.5">
          {status.transport === "unauthorized" && onRepair ? <SecondaryButton onClick={onRepair}>Pair again</SecondaryButton> : null}
          {status.transport === "reconnecting" || status.transport === "offline" ? <SecondaryButton onClick={onRetry}>Retry</SecondaryButton> : null}
          <button
            type="button"
            aria-label={`${environment.name} actions`}
            onClick={onMenu}
            className="pressable grid size-7 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content"
          >
            <MoreHorizontal className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ── dialogs ────────────────────────────────────────────────────────────────

const FIELD = "flex flex-col gap-1.5 text-[12px] text-content/50";

function AddDialog({ repair, onClose, onChanged }: { repair?: SavedEnvironment; onClose: () => void; onChanged: () => Promise<void> }) {
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

function RenameDialog({ env, onClose, onChanged }: { env: SavedEnvironment; onClose: () => void; onChanged: () => Promise<void> }) {
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

function RoutesDialog({ env, onClose, onChanged }: { env: SavedEnvironment; onClose: () => void; onChanged: () => Promise<void> }) {
  const [routes, setRoutes] = useState<SavedRoute[]>(env.routes);
  const [added, setAdded] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const move = (from: number, to: number) => {
    if (to < 0 || to >= routes.length) return;
    const next = [...routes];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    setRoutes(next);
  };
  const add = () => {
    const url = added.trim();
    if (!url) return;
    setRoutes([...routes, { url, kind: kindOf(url) }]);
    setAdded("");
  };
  const save = async () => {
    setPending(true);
    setError(null);
    try {
      await rpc("remote.environments.update", { id: env.id, routes });
      await onChanged();
      onClose();
    } catch (err) {
      setError(hostErrorText(err));
      setPending(false);
    }
  };
  return (
    <Modal onClose={onClose} busy={pending} title={`Routes to ${env.name}`} description="Best first. The window connects over the first that works and keeps trying the earlier ones." size="sm">
      <div className="flex flex-col gap-3 px-4 py-3">
        <ol className="flex flex-col">
          {routes.map((route, i) => (
            <li key={route.url} className="flex items-center gap-2 border-b border-content/5 py-2 last:border-b-0">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] text-content">{originText(route.url)}</div>
                <div className="text-[11px] text-content/40">{route.kind}</div>
              </div>
              <IconButton label="Move up" disabled={i === 0} onClick={() => move(i, i - 1)}>
                <ArrowUpLong className="size-3.5" strokeWidth={1.75} />
              </IconButton>
              <IconButton label="Move down" disabled={i === routes.length - 1} onClick={() => move(i, i + 1)}>
                <ArrowDownLong className="size-3.5" strokeWidth={1.75} />
              </IconButton>
              <IconButton label="Remove route" disabled={routes.length === 1} onClick={() => setRoutes(routes.filter((_, j) => j !== i))}>
                <X className="size-3.5" strokeWidth={1.75} />
              </IconButton>
            </li>
          ))}
        </ol>
        <div className="flex items-center gap-2">
          <Input
            value={added}
            onChange={(e) => setAdded(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            placeholder="https://host or ws://10.0.0.5:7677"
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1"
            aria-label="New route"
          />
          <SecondaryButton onClick={add} disabled={!added.trim()}>
            Add route
          </SecondaryButton>
        </div>
        <ErrorLine error={error} />
      </div>
      <DialogFooter onCancel={onClose} confirmLabel="Save" pending={pending} onConfirm={() => void save()} disabled={routes.length === 0} />
    </Modal>
  );
}

function IconButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="pressable grid size-6 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}
