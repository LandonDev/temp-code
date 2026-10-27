import { Search } from "../../chrome/icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HarnessIcon } from "../../chrome/HarnessIcon";
import { RemoveProjectDialog } from "../../chrome/RemoveProjectDialog";
import { prettyCwd, projectName } from "../../lib/paths";
import {
  loadArchivedProjects,
  looksLikeProject,
  subscribeArchivedProjects,
  type ArchivedProject,
} from "../../lib/recents";
import { HARNESS_TITLE, sessionDisplayTitle } from "../../lib/session";
import { loadSessionSidebarFilters, saveSessionSidebarFilters } from "../../lib/sessionFilters";
import { loadTabGroupLabels, resolveTabGroupLabel } from "../../lib/tabGroups";
import { useSessionMetas } from "../../lib/tcserver/store";
import { useProjects } from "../../lib/tcserver/workspaces";
import type { SessionMeta } from "@shared/events";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { useWorkspaces, workspaceLabelKey } from "../../lib/tcserver/workspaces";
import {
  Heading,
  Row,
  SecondaryButton,
  Toggle,
} from "../settingsBits";
import { DANGER } from "../../chrome/ConfirmDialog";

function useArchivedProjects(): ArchivedProject[] {
  const [items, setItems] = useState(loadArchivedProjects);
  useEffect(
    () => subscribeArchivedProjects(() => setItems(loadArchivedProjects())),
    [],
  );
  return items;
}

function useArchivedProjectLabel(): (path: string) => string {
  const workspaces = useWorkspaces();
  return (path) =>
    resolveTabGroupLabel(
      workspaceLabelKey(workspaces, path, projectName(path)),
      loadTabGroupLabels(),
      projectName(path),
    );
}

/** Archived threads render a page at a time: thousands of rows in one mount stalled the page switch. */
const ARCHIVE_PAGE = 100;

export function ArchivePage({
  onOpenSession,
  onArchiveSession,
  onDeleteSession,
  onRestoreProject,
  onDeleteProject,
}: {
  onOpenSession: (sessionId: string) => void;
  onArchiveSession: (sessionId: string, archived: boolean) => void;
  onDeleteSession: (
    sessionId: string,
    options?: { confirmed?: boolean },
  ) => void;
  onRestoreProject?: (path: string) => void;
  onDeleteProject?: (path: string) => void;
}) {
  const archivedProjectLabel = useArchivedProjectLabel();
  const [filters, setFilters] = useState(loadSessionSidebarFilters);
  const [deleting, setDeleting] = useState<ArchivedProject | null>(null);
  const [deletingThread, setDeletingThread] = useState<SessionMeta | null>(
    null,
  );
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(ARCHIVE_PAGE);
  const archivedProjects = useArchivedProjects();
  const metas = useSessionMetas();
  const projects = useProjects();
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );
  const nameOf = useCallback(
    (meta: SessionMeta) =>
      (meta.projectId ? projectNames.get(meta.projectId) : undefined) ??
      (looksLikeProject(meta.cwd) ? projectName(meta.cwd) : ""),
    [projectNames],
  );
  const archived = useMemo(
    () =>
      metas
        .filter((meta) => meta.archived && !meta.parentId)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [metas],
  );
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return archived;
    return archived.filter((meta) =>
      [meta.title, nameOf(meta), HARNESS_TITLE[meta.provider], meta.provider]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [archived, nameOf, query]);

  const onShowArchived = (showArchived: boolean) => {
    const next = { ...filters, showArchived };
    saveSessionSidebarFilters(next);
    setFilters(next);
  };

  const restore = (meta: SessionMeta) => {
    onArchiveSession(meta.id, false);
    onOpenSession(meta.id);
  };

  return (
    <>
      <Heading title="Archived projects" first />
      {archivedProjects.length === 0 ? (
        <p className="py-3 text-[12px] text-content/40">
          Archive a project from the rail to keep its chats out of the sidebar.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-content/10">
          {archivedProjects.map((project) => (
            <div
              key={project.path}
              className="flex items-center gap-3 border-b border-content/5 px-3 py-2 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px]">
                  {archivedProjectLabel(project.path)}
                </div>
                <div className="truncate text-[11px] text-content/40">
                  {prettyCwd(project.path)}
                </div>
              </div>
              {onRestoreProject ? (
                <SecondaryButton onClick={() => onRestoreProject(project.path)}>
                  Restore
                </SecondaryButton>
              ) : null}
              {onDeleteProject ? (
                <button type="button" onClick={() => setDeleting(project)} className={DANGER}>
                  Delete
                </button>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <Row
        label="Show archived in the sidebar"
        description="Keep archived conversations listed alongside the active ones."
      >
        <Toggle
          label="Show archived in the sidebar"
          on={filters.showArchived}
          onChange={onShowArchived}
        />
      </Row>

      <Heading title="Archived threads" />

      {archived.length === 0 ? (
        <p className="py-3 text-[12px] text-content/40">
          Nothing archived. Right-click a tab to archive it.
        </p>
      ) : (
        <>
          <label className="mb-3 flex h-7 items-center gap-2 rounded-lg border border-content/10 bg-content/5 px-2 text-[12px] text-content/40 focus-within:border-content/20">
            <Search className="size-3.5 shrink-0" strokeWidth={1.75} />
            <input
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setLimit(ARCHIVE_PAGE);
              }}
              placeholder="Search…"
              aria-label="Search archived threads"
              className="min-w-0 flex-1 bg-transparent text-content outline-none placeholder:text-content/40"
            />
          </label>
          {shown.length === 0 ? (
            <p className="py-3 text-[12px] text-content/40">
              No archived thread matches.
            </p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-content/10">
              {shown.slice(0, limit).map((meta) => (
                <div
                  key={meta.id}
                  className="flex items-center gap-3 border-b border-content/5 px-3 py-2 last:border-b-0"
                >
                  <HarnessIcon
                    harness={meta.provider}
                    className="size-3.5 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-[13px]">
                      {sessionDisplayTitle(meta.title, meta.provider)}
                    </span>
                    {nameOf(meta) ? (
                      <span className="block truncate text-[11px] text-content/40">
                        {nameOf(meta)}
                      </span>
                    ) : null}
                  </div>
                  <span className="shrink-0 text-[11px] text-content/40 tabular-nums">
                    {formatDate(meta.updatedAt)}
                  </span>
                  <SecondaryButton onClick={() => restore(meta)}>
                    Restore
                  </SecondaryButton>
                  <button type="button" onClick={() => setDeletingThread(meta)} className={DANGER}>
                    Delete
                  </button>
                </div>
              ))}
            </div>
          )}
          {shown.length > limit ? (
            <div className="mt-3">
              <SecondaryButton onClick={() => setLimit((n) => n + ARCHIVE_PAGE)}>
                Show more
              </SecondaryButton>
            </div>
          ) : null}
        </>
      )}

      {deleting ? (
        <RemoveProjectDialog
          name={archivedProjectLabel(deleting.path)}
          path={deleting.path}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            onDeleteProject?.(deleting.path);
            setDeleting(null);
          }}
        />
      ) : null}
      <DeleteThreadDialog
        thread={deletingThread}
        onCancel={() => setDeletingThread(null)}
        onConfirm={(thread) => {
          onDeleteSession(thread.id, { confirmed: true });
          setDeletingThread(null);
        }}
      />
    </>
  );
}

/** Deleting a thread is irreversible: one title, one line, Cancel and the verb.
 *  The last thread shown stays on the dialog while it closes. */
export function DeleteThreadDialog({
  thread,
  onCancel,
  onConfirm,
}: {
  thread: SessionMeta | null;
  onCancel: () => void;
  onConfirm: (thread: SessionMeta) => void;
}) {
  const shown = useRef(thread);
  if (thread) shown.current = thread;
  const meta = shown.current;
  return (
    <AlertDialog open={thread !== null} onOpenChange={(open) => (open ? null : onCancel())}>
      <AlertDialogContent>
        <DialogHeader>
          <DialogTitle>Delete {meta ? clampTitle(sessionDisplayTitle(meta.title, meta.provider)) : "thread"}?</DialogTitle>
          <DialogDescription>The thread and its whole transcript are gone for good.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => meta && onConfirm(meta)}>
            Delete thread
          </AlertDialogAction>
        </DialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function clampTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed.length > 48 ? `${trimmed.slice(0, 47)}…` : trimmed;
}

function formatDate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
    }).format(new Date(value));
  } catch {
    return "";
  }
}
