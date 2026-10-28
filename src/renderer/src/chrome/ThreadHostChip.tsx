import { useEffect, useState, type JSX } from "react";
import type { SessionMovePreview } from "@server/shared/contract-session-move";
import { registry, useEnvironments, useEnvironmentStatuses } from "../lib/connection";
import { copiesOf, ensureLinkedArgs, ensureLinkedOn, rememberLinkHost } from "../lib/projectHostChoice";
import { sessionStore, useQueue, useSession, useSessionMeta } from "../lib/tcserver/store";
import type { ProjectMeta, WorkspaceMeta } from "../lib/tcserver/types";
import { useWorkspaceCatalog } from "../lib/tcserver/workspaces";
import {
  dismissMoveNotice,
  moveNoticeException,
  movePreviewParts,
  moveTargets,
  moveThread,
  previewMove,
  useMoveNotices,
  useMoving,
} from "../lib/threadMove";
import { ConfirmDialog } from "./ConfirmDialog";
import { retargetDraft } from "./DraftHostPicker";
import { useToastSync } from "./toastSync";
import { Server } from "./icons";
import type { MenuRow } from "./menuRows";

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
  moves: MenuRow[];
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
  const moves: MenuRow[] = movingName
    ? [{ kind: "item", id: "moving", label: `Moving to ${movingName}…`, icon: Server, disabled: true }]
    : targets.map((t) => ({
        kind: "item",
        id: `move:${t.environmentId}`,
        label: `Move to ${t.name}…`,
        icon: Server,
        disabled: !t.ok,
        ...(t.ok ? {} : { reason: t.reason }),
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
      body={`Its subagents and pages move with it; undo history stays on ${fromName}.`}
      note={
        <span className="flex flex-wrap gap-x-2">
          {movePreviewParts(preview).map((part) => (
            <span key={part}>{part}</span>
          ))}
        </span>
      }
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

const NOTICE_MS = 8_000;

/** One sonner toast per finished move: "Moved "<title>" to box", with a
 *  second line only when something stayed behind or the move failed, and
 *  then it waits to be read; otherwise it leaves on its own. */
export function MoveToasts(): null {
  useToastSync(
    useMoveNotices(),
    (n) => `move:${n.key}`,
    (toast, n, id) => {
      const done = () => dismissMoveNotice(n.key);
      const description = n.error ? n.error.split("\n")[0] : moveNoticeException(n);
      const title = n.error ? `Couldn't move "${n.title}" to ${n.toName}` : `Moved "${n.title}" to ${n.toName}`;
      const show = n.error ? toast.error : toast;
      show(title, { id, description: description ?? undefined, duration: description ? Infinity : NOTICE_MS, closeButton: !!description, onDismiss: done, onAutoClose: done });
    },
  );
  return null;
}
