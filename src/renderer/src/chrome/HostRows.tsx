import { useEffect, useMemo, useState } from "react";
import { useEnvironments, useEnvironmentStatuses, useSlowEnvironments, type Environment } from "../lib/connection";
import { bootResumeLine, dismissBootResume, useBootResumeNotice } from "../lib/bootResume";
import { threadsToMarkReadOnHost } from "../lib/markRead";
import { markSessionsSeen, useLastSeen, useSeenFloor } from "../lib/sessionSeen";
import { useSessionMetas } from "../lib/tcserver/store";
import { useWorkspaceCatalog } from "../lib/tcserver/workspaces";
import { hostScope, requestThreadBatch } from "../lib/threadBatch";
import { batchActionOfMenuId, batchCounts, batchExplorerItems } from "../lib/threadBatchMenu";
import { selectionFor } from "../lib/threadBatchSelection";
import { shell } from "../stores/shell";
import { statusText } from "../lib/hostConnection";
import { DeployDriftMark } from "./DeployDrift";
import { toneOf } from "./EnvironmentSwitcher";
import { ExplorerMenu, type ExplorerMenuItem } from "./ExplorerMenu";
import { HostGlyph } from "./HostGlyph";
import { MoreHorizontal } from "./icons";

/** How long "7 threads resumed after restart" stays on a host's row. */
const RESUME_SHOWN_MS = 15_000;

/**
 * The hosts at the rail's foot, above Settings: one quiet 28 px row per
 * host when two or more are registered, nothing with one. A row reads the
 * host's glyph, its name, its connection dot, the boot-resume line while
 * it is fresh and the `+N` deploy drift; a click opens the host's menu
 * (Add workspace here, Mark all read, the fleet switches, Remote access).
 */
export function HostRows({ onAddWorkspace }: { onAddWorkspace: (environmentId: string) => void }) {
  const environments = useEnvironments();
  if (environments.length < 2) return null;
  return (
    <div role="list" aria-label="Hosts" className="flex shrink-0 flex-col gap-px px-2 pt-2 pb-1">
      {environments.map((environment) => (
        <HostRow key={environment.id} environment={environment} onAddWorkspace={onAddWorkspace} />
      ))}
    </div>
  );
}

function HostRow({ environment, onAddWorkspace }: { environment: Environment; onAddWorkspace: (environmentId: string) => void }) {
  const { id, name } = environment;
  const status = useEnvironmentStatuses().get(id);
  const slow = useSlowEnvironments().has(id);
  const notice = useBootResumeNotice(id);
  const metas = useSessionMetas();
  const catalog = useWorkspaceCatalog();
  const lastSeen = useLastSeen();
  const floor = useSeenFloor();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => dismissBootResume(notice.environmentId), RESUME_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const items = useMemo((): ExplorerMenuItem[] | null => {
    if (!menu) return null;
    const scope = hostScope(id);
    const counts = batchCounts(metas, { catalog, lastSeen, floor, scope });
    const unread = threadsToMarkReadOnHost(metas, id).ids.length;
    return [
      { kind: "item", id: "add", label: "Add workspace here…" },
      { kind: "sep" },
      ...batchExplorerItems(counts, unread),
      { kind: "sep" },
      { kind: "item", id: "settings", label: "Remote access settings" },
    ];
  }, [catalog, floor, id, lastSeen, menu, metas]);

  const onPick = (pick: string) => {
    setMenu(null);
    const action = batchActionOfMenuId(pick);
    if (action) {
      const scope = hostScope(id);
      void requestThreadBatch(action, scope, () => selectionFor(scope));
    } else if (pick === "add") onAddWorkspace(id);
    else if (pick === "read") {
      const { ids, at } = threadsToMarkReadOnHost(metas, id);
      markSessionsSeen(ids, at);
    } else if (pick === "settings") shell.openSettings("remote");
  };

  const state = status ? statusText(status, Date.now(), slow) : "not connected";
  const note = notice ? bootResumeLine(notice.count) : null;

  return (
    <div role="listitem" data-host-row={id}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={!!menu}
        aria-label={`${name}, ${state}${note ? `, ${note}` : ""}`}
        onClick={(event) => setMenu({ x: event.clientX, y: event.clientY })}
        className={`pressable group relative flex h-7 w-full cursor-default items-center gap-2 rounded-md px-2 text-left ${
          menu ? "bg-content/5 text-content" : "text-content/50 hover:bg-content/5 hover:text-content"
        }`}
      >
        {/* The 12px glyph in the rail icons' 14px box keeps the names on Settings' text column. */}
        <span aria-hidden className="grid size-3.5 shrink-0 place-items-center">
          <HostGlyph environmentId={id} />
        </span>
        <span className="min-w-0 shrink truncate text-[12px] leading-none">{name}</span>
        {status ? (
          <span
            data-host-status={status.transport}
            title={`${name}: ${state}`}
            className={`size-1.5 shrink-0 rounded-full ${toneOf(status, status.transport !== "open", slow)}`}
          />
        ) : null}
        <span className="flex min-w-0 flex-1 items-center justify-end gap-2 transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0">
          {note ? (
            <span data-boot-resume={notice!.count} title={note} className="min-w-0 truncate text-[11px] text-content/45">
              {note}
            </span>
          ) : null}
          <DeployDriftMark environmentId={id} />
        </span>
        <MoreHorizontal
          aria-hidden
          className="pointer-events-none absolute right-2 size-3.5 text-content/50 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          strokeWidth={1.75}
        />
      </button>
      {menu && items ? (
        <ExplorerMenu x={menu.x} y={menu.y} ariaLabel={`${name} actions`} items={items} onPick={onPick} onClose={() => setMenu(null)} />
      ) : null}
    </div>
  );
}
