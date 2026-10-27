import { useCallback, useEffect, useState, type MouseEvent } from "react";
import type { SavedEnvironment } from "@server/shared/contract-remote";
import { ConfirmDialog, ErrorLine, errorText } from "../chrome/ConfirmDialog";
import { ExplorerMenu, type ExplorerMenuItem } from "../chrome/ExplorerMenu";
import { MoreHorizontal } from "../chrome/icons";
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
import { SecondaryButton } from "./settingsBits";
import { capsText, originText, statusText } from "../lib/hostConnection";
import { AddHostDialog } from "./settings/hosts/dialogs/AddHostDialog";
import { RenameHostDialog } from "./settings/hosts/dialogs/RenameHostDialog";
import { RoutesDialog } from "./settings/hosts/dialogs/RoutesDialog";
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
      {dialog?.kind === "add" ? <AddHostDialog repair={dialog.repair} onClose={() => setDialog(null)} onChanged={refresh} /> : null}
      {dialog?.kind === "rename" ? <RenameHostDialog env={dialog.env} onClose={() => setDialog(null)} onChanged={refresh} /> : null}
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

