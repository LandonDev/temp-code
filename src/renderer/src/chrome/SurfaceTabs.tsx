import { GripVertical, Terminal, X } from "./icons";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useLayoutEffect, useRef } from "react";
import { basename } from "../lib/fs";
import { useGitSnapshot } from "../lib/gitIndexStore";
import { useEditorState } from "../lib/monaco/editorState";
import { projectForCwd } from "../lib/tcserver/projects";
import {
  isReleaseNotesTab,
  isReviewTab,
  isTerminalTab,
  type FilePaneTab,
} from "../lib/layout";
import { releaseNotesTitle } from "../lib/releaseNotes";
import { terminalTabLabel } from "../lib/terminalTab";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { useSortable } from "../hooks/useSortable";
import { FileTypeIcon } from "./FileTypeIcon";

type Props = {
  files: FilePaneTab[];
  activeFileId: string;
  dirtyFileIds: Set<string>;
  fileErrorCounts: Map<string, number>;
  onSelectFile: (fileId: string) => void;
  onCloseFile: (fileId: string) => void;
  onReorder: (ids: string[]) => void;
  onPaneDragStart?: (event: ReactPointerEvent<HTMLElement>) => void;
  label?: string;
  trailing?: ReactNode;
};

export type SurfaceTabPresentation = {
  name: string;
  label: string;
  iconName: string;
  tooltip: string;
};

export function surfaceTabPresentation(
  file: FilePaneTab,
): SurfaceTabPresentation {
  if (isReleaseNotesTab(file)) {
    const title = releaseNotesTitle(file.releaseNotes.version);
    return {
      name: title,
      label: title,
      iconName: "CHANGELOG.md",
      tooltip: title,
    };
  }

  const review = isReviewTab(file);
  const terminal = isTerminalTab(file);
  const name = terminal ? terminalTabLabel(file) : basename(file.path);
  const against = review ? (file.diffBase ? `vs ${shortRef(file.diffBase)}` : "Working Tree") : null;
  return {
    name,
    label: against ? `${name} (${against})` : name,
    iconName: name,
    tooltip: terminal ? `${name} · ${file.cwd}` : against ? `${file.path} (${against})` : file.path,
  };
}

/** A full sha reads as its first seven; branch names and HEAD stay whole. */
function shortRef(ref: string): string {
  return /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 7) : ref;
}

/** Mirrors the VS Code tab tooltip: the path, then what is wrong with it. */
export function appendProblems(title: string, errors: number): string {
  if (!errors) return title;
  return `${title} — ${errors} ${errors === 1 ? "problem" : "problems"}`;
}

export function SurfaceTabs({
  files,
  activeFileId,
  dirtyFileIds,
  fileErrorCounts,
  onSelectFile,
  onCloseFile,
  onReorder,
  onPaneDragStart,
  label = "Open files",
  trailing,
}: Props) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const activeTabRef = useRef<HTMLDivElement | null>(null);
  // Every tab of one pane shares a checkout; the pane's first file names it.
  const cwd = files[0]?.cwd ?? "";
  const { index } = useGitSnapshot(cwd);
  const changed = index?.files ?? [];
  const busy = useEditorState((s) => {
    const project = cwd ? projectForCwd(cwd) : undefined;
    return project ? (s.lspBusy[project.id] ?? null) : null;
  });
  const fileIds = files.map((file) => file.id);
  const sortable = useSortable(fileIds, onReorder);
  const canDrag = files.length > 1;

  useLayoutEffect(() => {
    if (sortable.draggingId) return;
    activeTabRef.current?.scrollIntoView({
      inline: "nearest",
      block: "nearest",
    });
  }, [activeFileId, sortable.draggingId]);

  return (
    <div className="flex h-9 min-w-0 shrink-0 border-b border-content/10 bg-content/2">
      <div
        ref={lockOverscroll}
        role="tablist"
        aria-label={label}
        className="scrollbar-none flex min-w-0 flex-1 overflow-x-auto overscroll-none"
      >
      {onPaneDragStart ? (
        <div
          role="button"
          title="Drag to reorder pane"
          aria-label="Drag to reorder pane"
          tabIndex={-1}
          className="grid h-full w-5 shrink-0 cursor-grab place-items-center text-content/35 hover:bg-content/5 hover:text-content/70 active:cursor-grabbing touch-none"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            onPaneDragStart(event);
          }}
        >
          <GripVertical className="size-3.5" strokeWidth={1.75} />
        </div>
      ) : null}
      {files.map((file, index) => {
        const active = file.id === activeFileId;
        const dirty = dirtyFileIds.has(file.id);
        const errors = fileErrorCounts.get(file.id) ?? 0;
        const review = isReviewTab(file);
        const terminal = isTerminalTab(file);
        const { label, iconName, tooltip } = surfaceTabPresentation(file);
        const change = terminal ? undefined : changed.find((f) => f.path === file.path);
        const dragging = sortable.draggingId === file.id;
        const showStart =
          sortable.draggingId &&
          sortable.toIndex === index &&
          sortable.fromIndex !== null &&
          sortable.toIndex < sortable.fromIndex;
        const showEnd =
          sortable.draggingId &&
          sortable.toIndex === index &&
          sortable.fromIndex !== null &&
          sortable.toIndex > sortable.fromIndex;
        return (
          <div
            key={file.id}
            ref={(el) => {
              sortable.setItemRef(file.id, el);
              if (el && file.id === activeFileId) activeTabRef.current = el;
            }}
            className={`group relative flex w-52 min-w-28 shrink touch-none items-stretch border-r border-content/10 ${
              active ? "bg-content/8" : "hover:bg-content/5"
            } ${dragging ? "opacity-40" : ""} ${
              canDrag ? "cursor-grab active:cursor-grabbing" : ""
            }`}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              if (
                (event.target as HTMLElement | null)?.closest("[data-no-drag]")
              ) {
                return;
              }
              onSelectFile(file.id);
              sortable.onItemPointerDown(file.id, event);
            }}
          >
            {showStart ? (
              <div className="pointer-events-none absolute inset-y-0 left-0 z-20 w-0.5 bg-accent" />
            ) : null}
            {showEnd ? (
              <div className="pointer-events-none absolute inset-y-0 right-0 z-20 w-0.5 bg-accent" />
            ) : null}
            <button
              type="button"
              role="tab"
              aria-selected={active}
              title={appendProblems(tooltip, errors)}
              onClick={() => {
                if (sortable.consumeClick()) return;
                onSelectFile(file.id);
              }}
              className={`flex min-w-0 flex-1 items-center gap-1.5 px-3 pr-8 text-left text-[12px] ${
                canDrag ? "cursor-grab active:cursor-grabbing" : ""
              } ${
                active ? "text-content" : "text-content/55 hover:text-content"
              }`}
            >
              {terminal ? (
                <Terminal className="size-3.5 shrink-0" strokeWidth={1.75} />
              ) : (
                <FileTypeIcon name={iconName} isDir={false} size={15} />
              )}
              <span
                className={`min-w-0 flex-1 truncate ${review ? "italic" : ""} ${
                  errors
                    ? active
                      ? "text-red-400"
                      : "text-red-400/75 group-hover:text-red-400"
                    : ""
                }`}
              >
                {label}
              </span>
              {change && change.status !== "untracked" && (change.additions > 0 || change.deletions > 0) ? (
                <span className="shrink-0 text-[10.5px] tabular-nums">
                  {change.additions > 0 ? <span className="text-success">+{change.additions}</span> : null}
                  {change.additions > 0 && change.deletions > 0 ? " " : ""}
                  {change.deletions > 0 ? <span className="text-danger">−{change.deletions}</span> : null}
                </span>
              ) : null}
              {dirty ? (
                <span
                  className="size-1.5 shrink-0 rounded-full bg-content/75"
                  title="Unsaved changes"
                  aria-label="Unsaved changes"
                />
              ) : null}
            </button>
            <button
              type="button"
              title={`Close ${label}`}
              aria-label={`Close ${label}`}
              data-no-drag
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onCloseFile(file.id);
              }}
              className={`absolute right-1.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-content/50 hover:bg-content/10 hover:text-content ${
                active ? "opacity-100" : "opacity-0 group-hover:opacity-100"
              }`}
            >
              <X className="size-3" strokeWidth={1.75} />
            </button>
          </div>
        );
      })}
      {onPaneDragStart ? (
        <div
          className="min-w-4 flex-1 cursor-grab active:cursor-grabbing"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            onPaneDragStart(event);
          }}
        />
      ) : null}
      </div>
      {busy ? (
        <div
          className="flex max-w-72 shrink-0 items-center truncate px-3 text-[11px] text-content/40 tabular-nums"
          title={busy}
        >
          {busy}
        </div>
      ) : null}
      {trailing}
    </div>
  );
}
