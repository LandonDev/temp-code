import { createPortal } from "react-dom";
import { useEffect, useRef, useState, type JSX } from "react";
import { registry, useEnvironments, useEnvironmentStatuses } from "../lib/connection";
import { LAYER } from "../lib/layers";
import { useQueue, useSession, useSessionMeta } from "../lib/tcserver/store";
import { dismissMoveNotice, hostTone, moveNoticeLines, moveTargets, moveThread, useMoveNotices, useMoving, type MoveNotice } from "../lib/threadMove";
import { ConfirmDialog } from "./ConfirmDialog";
import { ExplorerMenu, type ExplorerMenuItem } from "./ExplorerMenu";

/**
 * Which host the active thread lives on, with a status dot, and the menu
 * that moves it to the other one ("Move to box…"). Each target is disabled
 * with its reason when the thread is busy, a link is down or the key there
 * is not admin. A running move shows on the chip.
 */
export function ThreadHostChip({ sessionId }: { sessionId: string }): JSX.Element | null {
  const session = useSession(sessionId);
  const meta = useSessionMeta(sessionId);
  const environments = useEnvironments();
  const statuses = useEnvironmentStatuses();
  const queue = useQueue(sessionId);
  const moving = useMoving();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirm, setConfirm] = useState<{ to: string; name: string } | null>(null);
  if (!session) return null;
  const env = environments.find((e) => e.id === session.environmentId);
  // A window with one host has nothing to say here.
  if (!env || environments.length < 2) return null;
  const movingTo = moving.get(sessionId);
  const targets = moveTargets(
    {
      id: session.id,
      environmentId: session.environmentId,
      parentId: session.parentId,
      status: session.status,
      busy: session.busy,
      treeHasLiveWork: session.treeHasLiveWork,
      treeHasPaused: session.treeHasPaused,
      draft: !meta,
      queued: queue.length,
    },
    environments,
    (id) => statuses.get(id) ?? { transport: "offline", lastHello: null },
    !!movingTo,
  );
  const items: ExplorerMenuItem[] = [{ kind: "item", id: "host", label: `On ${env.name}`, disabled: true }];
  for (const t of targets) {
    items.push({ kind: "sep" }, { kind: "item", id: `move:${t.environmentId}`, label: `Move to ${t.name}…`, disabled: !t.ok });
    if (!t.ok) items.push({ kind: "item", id: `why:${t.environmentId}`, label: t.reason, disabled: true });
  }
  const movingName = movingTo ? (registry.environment(movingTo)?.name ?? movingTo) : null;
  return (
    <>
      <button
        type="button"
        data-tauri-drag-region="false"
        data-thread-host={session.environmentId}
        title={movingName ? `Moving to ${movingName}…` : `This thread runs on ${env.name}`}
        aria-busy={!!movingTo}
        onClick={(event) => {
          const r = event.currentTarget.getBoundingClientRect();
          setMenu({ x: r.left, y: r.bottom + 4 });
        }}
        className="flex h-6 max-w-40 items-center gap-1.5 rounded-md px-2 text-[12px] text-content/60 hover:bg-content/5 hover:text-content"
      >
        <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${movingTo ? "animate-pulse bg-warning" : hostTone(statuses.get(env.id))}`} />
        <span className="truncate">{movingName ? `Moving to ${movingName}…` : env.name}</span>
      </button>
      {menu ? (
        <ExplorerMenu
          x={menu.x}
          y={menu.y}
          items={items}
          ariaLabel="Thread host"
          onPick={(id) => {
            setMenu(null);
            if (!id.startsWith("move:")) return;
            const to = id.slice("move:".length);
            setConfirm({ to, name: registry.environment(to)?.name ?? to });
          }}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {confirm ? (
        <ConfirmDialog
          title={`Move this thread to ${confirm.name}?`}
          body={`The thread, its subagents, its transcript and its agent pages move to ${confirm.name} and run there from now on. Uncommitted changes in the working tree and the undo history stay on ${env.name}.`}
          confirmLabel="Move thread"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const to = confirm.to;
            setConfirm(null);
            // The result (or the refusal) arrives as a toast; the chip shows the move meanwhile.
            void moveThread(sessionId, to).catch(() => undefined);
          }}
        />
      ) : null}
    </>
  );
}

const NOTICE_MS = 12_000;

/** The result of each move, top right; a success fades on its own, a failure waits to be read. */
export function MoveToasts(): JSX.Element | null {
  const notices = useMoveNotices();
  if (notices.length === 0) return null;
  return createPortal(
    <div aria-live="polite" style={{ zIndex: LAYER.toast }} className="pointer-events-none fixed bottom-3 right-3 flex w-[min(380px,calc(100vw-24px))] flex-col gap-2">
      {notices.map((n) => (
        <MoveToast key={n.key} notice={n} />
      ))}
    </div>,
    document.body,
  );
}

function MoveToast({ notice }: { notice: MoveNotice }): JSX.Element {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (notice.error) return;
    timer.current = setTimeout(() => dismissMoveNotice(notice.key), NOTICE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [notice.key, notice.error]);
  const lines = moveNoticeLines(notice);
  return (
    <article role="status" data-move-notice={notice.error ? "error" : "ok"} className="pointer-events-auto overflow-hidden rounded-xl px-3.5 py-3 shadow-xl glass-surface floating-surface">
      <div className="flex items-start gap-2">
        <span className={`min-w-0 flex-1 text-[13px] font-semibold leading-snug ${notice.error ? "text-danger" : "text-content"}`}>
          {notice.error ? `Could not move "${notice.title}" to ${notice.toName}` : `Moved "${notice.title}" to ${notice.toName}`}
        </span>
        <button type="button" className="shrink-0 text-[11px] text-content/40 hover:text-content" onClick={() => dismissMoveNotice(notice.key)}>
          Dismiss
        </button>
      </div>
      {lines.map((line) => (
        <p key={line} className="mt-1.5 text-[12px] leading-relaxed text-content/70">
          {line}
        </p>
      ))}
    </article>
  );
}
