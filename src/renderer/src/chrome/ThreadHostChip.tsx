import { createPortal } from "react-dom";
import { useEffect, useRef, useState, type JSX } from "react";
import type { SessionMovePreview } from "@server/shared/contract-session-move";
import { registry, useEnvironments, useEnvironmentStatuses } from "../lib/connection";
import { LAYER } from "../lib/layers";
import { copiesOf, ensureLinkedArgs, ensureLinkedOn, rememberLinkHost } from "../lib/projectHostChoice";
import { sessionStore, useQueue, useSession, useSessionMeta } from "../lib/tcserver/store";
import type { ProjectMeta, WorkspaceMeta } from "../lib/tcserver/types";
import { useWorkspaceCatalog } from "../lib/tcserver/workspaces";
import {
  dismissMoveNotice,
  moveNoticeLines,
  movePreviewLine,
  moveTargets,
  moveThread,
  previewMove,
  useMoveNotices,
  useMoving,
  type MoveNotice,
} from "../lib/threadMove";
import { ConfirmDialog } from "./ConfirmDialog";
import { retargetDraft } from "./DraftHostPicker";
import type { ExplorerMenuItem } from "./ExplorerMenu";

/**
 * The active thread's host for the thread menu (chrome/ThreadMenu.tsx):
 * the host's name when the window has two or more, and the rows that move
 * the thread to another ("Move to box…"), each disabled with its reason as
 * the row's second line when the thread is busy, a link is down or the key
 * there is not admin. An unsent draft just switches to the other host's
 * copy of its project, and a thread nobody wrote to yet moves at once; only
 * a thread with messages asks first, the confirm saying what the move
 * carries (the branch and its uncommitted changes). `pick` answers the
 * menu's `move:` rows and leaves every other id to the caller.
 */
export function useThreadHost(sessionId: string | null): {
  host: { environmentId: string; name: string } | null;
  movingTo: string | null;
  moves: ExplorerMenuItem[];
  pick: (id: string) => boolean;
  dialog: JSX.Element | null;
} {
  const session = useSession(sessionId ?? "");
  const meta = useSessionMeta(sessionId ?? "");
  const environments = useEnvironments();
  const statuses = useEnvironmentStatuses();
  const queue = useQueue(sessionId ?? "");
  const moving = useMoving();
  const { projects, workspaces } = useWorkspaceCatalog();
  const [confirm, setConfirm] = useState<{ to: string; name: string } | null>(null);
  const env = session ? environments.find((e) => e.id === session.environmentId) : undefined;
  // A window with one host has nothing to say here.
  if (!session || !sessionId || !env || environments.length < 2) {
    return { host: null, movingTo: null, moves: [], pick: () => false, dialog: null };
  }
  const movingTo = moving.get(sessionId) ?? null;
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
  const movingName = movingTo ? (registry.environment(movingTo)?.name ?? movingTo) : null;
  const moves: ExplorerMenuItem[] = movingName
    ? [{ kind: "item", id: "moving", label: `Moving to ${movingName}…`, disabled: true }]
    : targets.map((t) => ({
        kind: "item",
        id: `move:${t.environmentId}`,
        label: `Move to ${t.name}…`,
        disabled: !t.ok,
        ...(t.ok ? {} : { description: t.reason }),
      }));
  const pick = (id: string): boolean => {
    if (!id.startsWith("move:")) return false;
    const to = id.slice("move:".length);
    if (!meta) {
      void retargetDraftTo(sessionId, to, projects, workspaces).catch(() => undefined);
    } else if (session.loaded && !session.blocks.some((b) => b.role === "user")) {
      // Nothing written yet: nothing to carry, nothing to confirm.
      void moveThread(sessionId, to).catch(() => undefined);
    } else {
      setConfirm({ to, name: registry.environment(to)?.name ?? to });
    }
    return true;
  };
  const dialog = confirm ? (
    <MoveThreadConfirm sessionId={sessionId} to={confirm.to} toName={confirm.name} fromName={env.name} onClose={() => setConfirm(null)} />
  ) : null;
  return { host: { environmentId: env.id, name: env.name }, movingTo, moves, pick, dialog };
}

/** The confirm before a thread with messages moves, saying what travels
 *  (`session.move.preview`). The result, or the refusal, arrives as a toast. */
export function MoveThreadConfirm({
  sessionId,
  to,
  toName,
  fromName,
  onClose,
}: {
  sessionId: string;
  to: string;
  toName: string;
  fromName: string;
  onClose: () => void;
}): JSX.Element {
  const [preview, setPreview] = useState<SessionMovePreview | null | "error">(null);
  useEffect(() => {
    let live = true;
    previewMove(sessionId).then(
      (p) => live && setPreview(p),
      () => live && setPreview("error"),
    );
    return () => {
      live = false;
    };
  }, [sessionId]);
  return (
    <ConfirmDialog
      title={`Move this thread to ${toName}?`}
      body={`The thread, its subagents, its transcript and its agent pages move to ${toName} and run there from now on. The undo history stays on ${fromName}.`}
      note={movePreviewLine(preview)}
      confirmLabel="Move thread"
      onCancel={onClose}
      onConfirm={() => {
        onClose();
        void moveThread(sessionId, to).catch(() => undefined);
      }}
    />
  );
}

/** An unsent draft onto `to`'s copy of its project, made there when missing (DraftHostPicker's pick). */
async function retargetDraftTo(
  sessionId: string,
  to: string,
  projects: readonly ProjectMeta[],
  workspaces: readonly WorkspaceMeta[],
): Promise<void> {
  const draft = sessionStore.get(sessionId);
  const project = draft?.projectId ? projects.find((p) => p.id === draft.projectId && p.environmentId === draft.environmentId) : undefined;
  if (!project?.linkId) throw new Error("the draft's project is not linked to that host");
  const copy =
    copiesOf(projects, project.linkId).find((c) => c.environmentId === to) ??
    (await (async () => {
      const ws = workspaces.find((w) => w.id === project.workspaceId && w.environmentId === project.environmentId);
      const args = ensureLinkedArgs(project, ws);
      return args ? (await ensureLinkedOn(to, args)).project : null;
    })());
  if (!copy) throw new Error("no copy of the project on that host");
  retargetDraft(sessionId, copy);
  rememberLinkHost(project.linkId, to);
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
