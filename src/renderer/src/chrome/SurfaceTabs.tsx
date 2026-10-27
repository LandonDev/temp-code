import { MOD } from "../lib/platform";
import { GripVertical, Terminal, X } from "./icons";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button";
import { Kbd } from "../components/ui/kbd";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip";
import { basename } from "../lib/fs";
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
    tooltip: terminal ? file.cwd : against ? `${file.path} (${against})` : file.path,
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
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // Every tab of one pane shares a checkout; the pane's first file names it.
  const cwd = files[0]?.cwd ?? "";
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
    <TooltipProvider>
      <Tabs
        value={activeFileId}
        onValueChange={(value) => {
          if (typeof value === "string" && value !== activeFileId) onSelectFile(value);
        }}
        className="h-9 min-w-0 shrink-0 gap-0 border-b border-border data-[orientation=horizontal]:flex-row"
      >
        <TabsList
          ref={lockOverscroll}
          variant="line"
          aria-label={label}
          className="scrollbar-none min-w-0 flex-1 items-stretch justify-start overflow-x-auto overflow-y-hidden overscroll-none px-1 group-data-[orientation=horizontal]/tabs:h-full"
        >
          {onPaneDragStart ? (
            <div className="shrink-0 pt-1">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Drag to reorder pane"
                      tabIndex={-1}
                      className="w-5 cursor-grab touch-none text-muted-foreground hover:text-foreground active:cursor-grabbing"
                      onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        event.preventDefault();
                        event.stopPropagation();
                        onPaneDragStart(event);
                      }}
                    />
                  }
                >
                  <GripVertical />
                </TooltipTrigger>
                <TooltipContent>Drag to reorder pane</TooltipContent>
              </Tooltip>
            </div>
          ) : null}
          {files.map((file, index) => {
            const active = file.id === activeFileId;
            const hovered = file.id === hoveredId;
            const dirty = dirtyFileIds.has(file.id);
            const errors = fileErrorCounts.get(file.id) ?? 0;
            const review = isReviewTab(file);
            const terminal = isTerminalTab(file);
            const { label, iconName, tooltip } = surfaceTabPresentation(file);
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
            // A dirty tab keeps its dot until hovered; a clean one offers close
            // while it is active or hovered.
            const closable = hovered || (active && !dirty);
            return (
              <div
                key={file.id}
                ref={(el) => {
                  sortable.setItemRef(file.id, el);
                  if (el && file.id === activeFileId) activeTabRef.current = el;
                }}
                className={`relative min-w-24 max-w-52 shrink pt-1 ${dragging ? "opacity-40" : ""}`}
                onMouseEnter={() => setHoveredId(file.id)}
                onMouseLeave={() => setHoveredId((id) => (id === file.id ? null : id))}
              >
                {showStart ? (
                  <div className="pointer-events-none absolute inset-y-1.5 -left-0.5 z-20 w-0.5 rounded-full bg-accent" />
                ) : null}
                {showEnd ? (
                  <div className="pointer-events-none absolute inset-y-1.5 -right-0.5 z-20 w-0.5 rounded-full bg-accent" />
                ) : null}
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <TabsTrigger
                        value={file.id}
                        onPointerDown={(event) => {
                          if (event.button !== 0) return;
                          onSelectFile(file.id);
                          sortable.onItemPointerDown(file.id, event);
                        }}
                        className={`h-7 w-full flex-none touch-none justify-start gap-2 font-normal transition-none hover:bg-foreground/5 hover:transition-[background-color,color] group-data-[variant=line]/tabs-list:rounded-md group-data-[variant=line]/tabs-list:px-3 group-data-[variant=line]/tabs-list:pr-9 group-data-[variant=line]/tabs-list:after:-bottom-[3px] group-data-[variant=line]/tabs-list:after:transition-none ${
                          canDrag ? "cursor-grab active:cursor-grabbing" : ""
                        }`}
                      />
                    }
                  >
                    {terminal ? (
                      <Terminal className="size-3.5" />
                    ) : (
                      <FileTypeIcon name={iconName} isDir={false} size={14} />
                    )}
                    <span
                      className={`min-w-0 truncate text-left ${review ? "italic" : ""} ${
                        errors ? "text-destructive" : ""
                      }`}
                    >
                      {label}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{appendProblems(tooltip, errors)}</TooltipContent>
                </Tooltip>
                <span className="pointer-events-none absolute top-1 right-3 grid h-7 w-4 place-items-center">
                  {closable ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`Close ${label}`}
                            className="pointer-events-auto size-4 rounded-sm text-muted-foreground hover:text-foreground"
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                              event.stopPropagation();
                              onCloseFile(file.id);
                            }}
                          />
                        }
                      >
                        <X />
                      </TooltipTrigger>
                      <TooltipContent>
                        Close <Kbd>{MOD}W</Kbd>
                      </TooltipContent>
                    </Tooltip>
                  ) : dirty ? (
                    <span
                      role="img"
                      aria-label="Unsaved changes"
                      className={`size-1.5 rounded-full bg-current ${active ? "text-foreground" : "text-muted-foreground"}`}
                    />
                  ) : null}
                </span>
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
        </TabsList>
        {busy ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <div className="flex max-w-72 shrink-0 items-center px-3 text-[12px] text-muted-foreground tabular-nums" />
              }
            >
              <span className="min-w-0 truncate">{busy}</span>
            </TooltipTrigger>
            <TooltipContent>{busy}</TooltipContent>
          </Tooltip>
        ) : null}
        {trailing}
      </Tabs>
    </TooltipProvider>
  );
}
