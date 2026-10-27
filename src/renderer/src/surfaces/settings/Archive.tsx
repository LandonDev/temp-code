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
import { useWorkspaces, workspaceLabelKey } from "../../lib/tcserver/workspaces";
import { PageEmpty, PageRow, PageSection } from "../../components/page";
import { SettingSwitch } from "../../components/setting-switch";
import { Button } from "../../components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/ui/dropdown-menu";
import { MoreHorizontal } from "../../chrome/icons";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";

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
      <PageSection>
        <PageRow title="Archived in the sidebar">
          <SettingSwitch label="Archived in the sidebar" on={filters.showArchived} onChange={onShowArchived} />
        </PageRow>
      </PageSection>

      <PageSection title="Archived projects">
        {archivedProjects.length === 0 ? (
          <PageEmpty>No archived projects</PageEmpty>
        ) : (
          archivedProjects.map((project) => (
            <PageRow
              key={project.path}
              title={archivedProjectLabel(project.path)}
              description={<span className="font-mono">{prettyCwd(project.path)}</span>}
            >
              <RowActions
                name={archivedProjectLabel(project.path)}
                verb="Remove"
                onRestore={onRestoreProject ? () => onRestoreProject(project.path) : undefined}
                onDelete={onDeleteProject ? () => setDeleting(project) : undefined}
              />
            </PageRow>
          ))
        )}
      </PageSection>

      <PageSection title="Archived threads">
        {archived.length === 0 ? (
          <PageEmpty>No archived threads</PageEmpty>
        ) : (
          <>
            <Input
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setLimit(ARCHIVE_PAGE);
              }}
              placeholder="Search archived threads"
              aria-label="Search archived threads"
              className="mb-1"
            />
            {shown.length === 0 ? (
              <PageEmpty>No archived thread matches</PageEmpty>
            ) : (
              shown.slice(0, limit).map((meta) => (
                <PageRow
                  key={meta.id}
                  media={<HarnessIcon harness={meta.provider} className="size-4 shrink-0" />}
                  title={sessionDisplayTitle(meta.title, meta.provider)}
                  description={nameOf(meta) || undefined}
                >
                  <RowActions
                    name={sessionDisplayTitle(meta.title, meta.provider)}
                    onRestore={() => restore(meta)}
                    onDelete={() => setDeletingThread(meta)}
                  />
                  <span className="text-[12px] text-muted-foreground tabular-nums">{formatDate(meta.updatedAt)}</span>
                </PageRow>
              ))
            )}
            {shown.length > limit ? (
              <div className="mt-3">
                <Button variant="secondary" size="sm" onClick={() => setLimit((n) => n + ARCHIVE_PAGE)}>
                  Show more
                </Button>
              </div>
            ) : null}
          </>
        )}
      </PageSection>

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
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {meta ? clampTitle(sessionDisplayTitle(meta.title, meta.provider)) : "thread"}?</AlertDialogTitle>
          <AlertDialogDescription>Its transcript is gone for good.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => meta && onConfirm(meta)}>
            Delete thread
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Restore, then a ⋯ menu holding the removing verb (Delete… for a thread,
 *  Remove… for a workspace whose folder stays): one verb on the row, the
 *  destructive one a step away. Shown on hover, on focus and while the
 *  menu is open. */
function RowActions({
  name,
  verb = "Delete",
  onRestore,
  onDelete,
}: {
  name: string;
  verb?: "Delete" | "Remove";
  onRestore?: () => void;
  onDelete?: () => void;
}) {
  return (
    <span className="flex items-center gap-1 opacity-0 transition-opacity duration-(--dur-fast) group-hover/item:opacity-100 group-focus-within/item:opacity-100 has-[[data-popup-open]]:opacity-100">
      {onRestore ? (
        <Button variant="ghost" size="sm" aria-label={`Restore ${name}`} onClick={onRestore}>
          Restore
        </Button>
      ) : null}
      {onDelete ? (
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`More for ${name}`} />}>
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent size="sm" align="end">
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              {verb}…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </span>
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
