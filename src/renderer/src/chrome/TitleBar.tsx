import { leafIds } from "../lib/layout";
import { sessionStore } from "../lib/tcserver/store";
import { workspaceTabsStore } from "../stores/workspace";
import { registry } from "../lib/connection";
import { environmentOfCwd } from "../lib/tcserver/projects";
import {
  ChevronLeft,
  ChevronRight,
  Folder,
  FolderPlus,
  GitCompare,
  Inbox,
  PanelLeft,
  Plus,
  Search,
  Settings,
  StickyNote,
  Terminal,
  Ungroup,
  X,
} from "./icons";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { basename } from "../lib/fs";
import { looksLikeProject } from "../lib/recents";
import type { HarnessId } from "../lib/session";
import {
  canJoinTabGroup,
  canJoinTabOnto,
  loadCollapsedTabGroups,
  loadTabGroupColors,
  loadTabGroupCustomColors,
  loadTabGroupLabels,
  TAB_GROUP_LABELS_CHANGED,
  loadTabGroupMascots,
  loadTabGroupLogos,
  reorderTabSegments,
  resolveTabGroupColor,
  resolveTabGroupColorIndex,
  resolveTabGroupCustomColor,
  resolveTabGroupLabel,
  resolveTabGroupMascot,
  resolveTabGroupLogo,
  saveCollapsedTabGroups,
  saveTabGroupColor,
  saveTabGroupCustomColor,
  saveTabGroupLabel,
  saveTabGroupMascot,
  sharedGroupProject,
  TAB_GROUP_LOGOS_CHANGED,
  segmentTabs,
  type TabGroupSegment,
} from "../lib/tabGroups";
import { CUSTOMIZE, groupActionOf, groupMenuRows, type TabGroupMenuAction } from "./TabGroupMenu";
import { ConfirmDialog } from "./ConfirmDialog";
import { CwdPicker } from "./CwdPicker";
import { RowsContextMenu, tidy, type MenuRow } from "./menuRows";
import { useThreadMenu } from "./useThreadMenu";
import { ProjectLogoIcon } from "./ProjectLogoIcon";
import { ProjectMascot } from "./ProjectMascot";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { useProjectDiffStats } from "../hooks/useProjectDiffStats";
import { useSegmentDrag } from "../hooks/useSegmentDrag";
import { useSortable, type SortableDropTarget } from "../hooks/useSortable";
import { FileTypeIcon } from "./FileTypeIcon";
import { HarnessIcon } from "./HarnessIcon";
import { TabIndicator, type TabThread } from "./TabIndicator";
import { ThreadHeader, type ThreadHeaderProps } from "./ThreadHeader";
import type { ThreadType } from "../lib/tcserver/types";
import { THREAD_GLYPHS, THREAD_LABELS, THREAD_TINTS } from "../surfaces/threads/threadTypes";
import { WindowControls } from "./WindowControls";
import { IS_MAC, MOD } from "../lib/platform";
import type { RecentProject } from "../lib/recents";
import { useShell } from "../stores/shell";
import { sessionPrefetch, tabSessionIds } from "../lib/sessionPrefetch";
import type { IntentProps } from "../lib/lazyChunk";
import { diffChunk, settingsChunk, terminalChunk, customizeChunk } from "../surfaces/chunks";

/** The Customize dialog loads with the click (its menu warms it). */
const CustomizeGroupDialog = customizeChunk.surface("CustomizeGroupDialog");

export type Tab = {
  id: string;
  /** Project folder name, e.g. `agent-terminal`. */
  project: string;
  /** Focused conversation title; empty for a fresh session. */
  title: string;
  /** Other conversation titles in this tab, focused session omitted. */
  more: string[];
  sessionCount: number;
  harnesses: HarnessId[];
  /** Harnesses with an in-flight turn in this tab. */
  busyHarnesses: HarnessId[];
  /** Open file basenames, active files first. */
  files: string[];
  /** Split layout with more than one pane in this tab. */
  multiPane?: boolean;
  /** Focus is on a file/terminal pane rather than a conversation pane. */
  fileFocused?: boolean;
  /** Explicit tab group; absent means ungrouped. */
  groupId?: string;
  dirty?: boolean;
  terminal?: boolean;
  /** The focused thread's type and live state, for the edge indicator. */
  thread?: TabThread;
  /** Last activity on the focused thread; the strip orders freshest first. */
  updatedAt?: number;
};

/** The group menu's "New …" rows for the four non-chat thread types;
 *  "New tab in group" stays the chat. */
const NEW_THREAD_ROWS: MenuRow[] = (["planning", "implementation", "research", "orchestration"] as const).map((type) => ({
  kind: "item",
  id: `new:${type}`,
  label: `New ${THREAD_LABELS[type].toLowerCase()} thread`,
  icon: THREAD_GLYPHS[type],
}));

const GROUP_MENU = "group:";

/** The thread a tab shows: its focused pane's, else its first. */
function tabThreadId(tabId: string): string | null {
  const tab = workspaceTabsStore.getState().tabs.find((entry) => entry.id === tabId);
  if (!tab) return null;
  return tab.focusedId ?? leafIds(tab.layout)[0] ?? null;
}

type Props = {
  tabs: Tab[];
  activeId: string;
  cwd: string;
  gitCwd?: string;
  deckLayout?: boolean;
  sourceControlActive?: boolean;
  onToggleSidebar: () => void;
  onShowSourceControl?: () => void;
  onSelect: (id: string) => void;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
  onNew: () => void;
  onNewTerminal?: () => void;
  onShowTerminal?: () => void;
  projectTerminalActive?: boolean;
  onOpenSettings?: () => void;
  onOpenInbox?: () => void;
  onOpenNotes?: () => void;
  onClose: (id: string) => void;
  onReorder: (ids: string[], movedId?: string) => void;
  onGoToFile?: () => void;
  onJoinTab?: (draggedId: string, targetId: string) => void;
  onJoinTabToGroup?: (tabId: string, groupId: string) => void;
  onAddToNewGroup?: (tabId: string) => void;
  onAddToGroup?: (tabId: string, groupId: string) => void;
  onRemoveFromGroup?: (tabId: string) => void;
  onUngroup?: (groupId: string) => void;
  onGroupNewTab?: (groupId: string, threadType?: ThreadType) => void;
  /** Deck mode: temp-code's thread strip and heading controls, in the strip's place. */
  header?: ThreadHeaderProps;
  onGroupClose?: (tabIds: string[]) => void;
  onGroupMoveToNewWindow?: (tabIds: string[]) => void;
  recents?: RecentProject[];
  onSelectProject?: (path: string) => void;
};

function sessionMeta(tab: Tab): string {
  if (tab.more.length === 1) return tab.more[0];
  if (tab.sessionCount > 1) return `${tab.sessionCount} sessions`;
  return "";
}

export function tabCopy(
  tab: Tab,
  options?: { inGroup?: boolean; deckLayout?: boolean },
): {
  headline: string;
  meta: string;
  tooltip: string;
} {
  const inGroup = options?.inGroup ?? false;
  const deckLayout = options?.deckLayout ?? false;
  const project = tab.project.trim() || "~";
  const conversation = tab.title.trim();
  const file = tab.files[0] ?? "";
  const sessions = sessionMeta(tab);
  const untitled = deckLayout ? "New session" : inGroup ? "New chat" : project;

  let headline: string;
  const metaParts: string[] = [];

  if (tab.multiPane) {
    if (tab.fileFocused && file) {
      headline = file;
      if (conversation) metaParts.push(conversation);
      else if (sessions) metaParts.push(sessions);
    } else if (conversation) {
      headline = conversation;
      if (file) metaParts.push(file);
      else if (sessions) metaParts.push(sessions);
    } else if (file) {
      headline = file;
      if (sessions) metaParts.push(sessions);
    } else {
      headline = untitled;
      if (sessions) metaParts.push(sessions);
    }
  } else {
    headline = conversation || file || untitled;
    if (!deckLayout && !inGroup && headline !== project && project !== "~") {
      metaParts.push(project);
    }
    if (sessions) metaParts.push(sessions);
  }

  const meta = metaParts.join(" · ");

  const tooltipParts = [project];
  if (conversation) tooltipParts.push(conversation);
  tooltipParts.push(...tab.more);
  if (tab.files.length > 0) tooltipParts.push(tab.files.join(", "));
  if (tab.dirty) tooltipParts.push("Unsaved changes");

  return { headline, meta, tooltip: tooltipParts.join(" · ") };
}

/** Which tab-strip edges still have overflow to scroll toward. */
export function tabStripOverflow(
  scrollLeft: number,
  clientWidth: number,
  scrollWidth: number,
): { left: boolean; right: boolean } {
  const maxScroll = scrollWidth - clientWidth;
  if (maxScroll <= 1) return { left: false, right: false };
  return {
    left: scrollLeft > 1,
    right: scrollLeft < maxScroll - 1,
  };
}

function TabHarnesses({
  harnesses,
  dimmed,
}: {
  harnesses: HarnessId[];
  dimmed: boolean;
}) {
  const shown = harnesses.slice(0, 3);
  const extra = harnesses.length - shown.length;
  const opacity = dimmed ? "opacity-55" : "opacity-100";

  return (
    <span className="flex shrink-0 items-center">
      {shown.map((harness, i) => (
        <span
          key={harness}
          className={`grid size-3.5 shrink-0 place-items-center ${opacity} ${
            i > 0 ? "-ml-0.5" : ""
          }`}
        >
          <HarnessIcon harness={harness} className="size-3.5 shrink-0" />
        </span>
      ))}
      {extra > 0 ? (
        <span
          className={`pl-0.5 text-[11px] leading-none tabular-nums ${dimmed ? "text-muted-foreground" : "text-foreground"}`}
        >
          +{extra}
        </span>
      ) : null}
    </span>
  );
}

type TabGroupPosition = "first" | "middle" | "last" | "only";

type SortableApi = ReturnType<typeof useSortable>;

/** `blocked` marks a drop the tab bar refuses — groups never span projects. */
type TabDropTarget = "join" | "blocked";

function dropTargetFor(
  target: SortableDropTarget | null,
  kind: "tab" | "group",
  id: string,
): TabDropTarget | null {
  if (!target || target.kind !== kind || target.id !== id) return null;
  return target.allowed ? "join" : "blocked";
}

function dropTargetTint(target: TabDropTarget): string {
  return target === "blocked" ? "bg-danger/20" : "bg-accent/20";
}

type SegmentDragApi = ReturnType<typeof useSegmentDrag>;

/** A finished, read thread: a small faded chip that lifts back to a tab on new activity. */
function TitleTabItem({
  tab,
  index,
  active,
  closable,
  canDrag,
  sortable,
  onSelect,
  onClose,
  dropTarget,
  groupPosition,
  itemRef,
  deckLayout = false,
}: {
  tab: Tab;
  index: number;
  active: boolean;
  closable: boolean;
  canDrag: boolean;
  sortable: SortableApi;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  dropTarget?: TabDropTarget | null;
  groupPosition?: TabGroupPosition;
  itemRef?: (el: HTMLDivElement | null) => void;
  deckLayout?: boolean;
}) {
  const dragging = canDrag && sortable.draggingId === tab.id;
  const TypeGlyph =
    tab.thread?.type && tab.thread.type !== "chat"
      ? THREAD_GLYPHS[tab.thread.type as ThreadType]
      : null;
  const inGroup = groupPosition != null;
  const { headline, meta, tooltip } = tabCopy(tab, { inGroup, deckLayout });
  const fileIcon = tab.files[0];
  const showStart =
    canDrag &&
    sortable.draggingId &&
    sortable.toIndex === index &&
    sortable.fromIndex !== null &&
    sortable.toIndex < sortable.fromIndex;
  const showEnd =
    canDrag &&
    sortable.draggingId &&
    sortable.toIndex === index &&
    sortable.fromIndex !== null &&
    sortable.toIndex > sortable.fromIndex;

  return (
    <div
      ref={(el) => {
        sortable.setItemRef(tab.id, el);
        itemRef?.(el);
      }}
      className={`group @container relative flex h-full cursor-default touch-none items-center self-stretch ${
        deckLayout ? "min-w-0 w-full" : "w-56 min-w-28 shrink"
      } ${dragging ? "opacity-40" : ""}`}
      onPointerEnter={() => sessionPrefetch.enter(tab.id, () => tabSessionIds(tab.id))}
      onPointerLeave={() => sessionPrefetch.leave(tab.id)}
      data-tauri-drag-region="false"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        if ((event.target as HTMLElement | null)?.closest("[data-no-drag]")) {
          return;
        }
        onSelect(tab.id);
        if (canDrag) sortable.onItemPointerDown(tab.id, event);
      }}
      data-menu-id={tab.id}
    >
      {showStart ? (
        <div className="pointer-events-none absolute inset-y-1.5 left-0 z-20 w-0.5 rounded-full bg-accent" />
      ) : null}
      {showEnd ? (
        <div className="pointer-events-none absolute inset-y-1.5 right-0 z-20 w-0.5 rounded-full bg-accent" />
      ) : null}
      {dropTarget ? (
        <div
          className={`pointer-events-none absolute inset-x-0 inset-y-1.5 z-10 rounded-md ${dropTargetTint(dropTarget)}`}
        />
      ) : null}
      <button
        type="button"
        title={tooltip}
        aria-label={tooltip}
        data-tauri-drag-region="false"
        onClick={() => {
          if (sortable.consumeClick()) return;
          onSelect(tab.id);
        }}
        className={`relative flex h-7 min-w-0 flex-1 cursor-default items-center gap-1.5 self-center rounded-md px-2 text-left ${
          closable ? "pr-8" : "pr-2"
        } ${
          active
            ? "bg-muted text-foreground"
            : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
        }`}
      >
        {TypeGlyph ? (
          <TypeGlyph
            className={`size-3.5 shrink-0 ${THREAD_TINTS[tab.thread!.type as ThreadType]} ${
              active ? "" : "opacity-50"
            }`}
            strokeWidth={1.75}
          />
        ) : tab.harnesses.length > 0 ? (
          <TabHarnesses harnesses={tab.harnesses} dimmed={!active} />
        ) : tab.terminal || !fileIcon ? (
          <Terminal
            className={`size-3.5 shrink-0 ${
              active ? "text-foreground" : "text-muted-foreground"
            }`}
            strokeWidth={1.75}
          />
        ) : (
          <span className={!active ? "opacity-50" : undefined}>
            <FileTypeIcon name={fileIcon} isDir={false} size={14} />
          </span>
        )}
        <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
          <span className="flex min-w-0 items-center gap-1">
            <span
              className={`min-w-0 truncate leading-none ${
                meta
                  ? "text-[13px] @min-[11rem]:text-[11px] @min-[11rem]:font-medium"
                  : "text-[13px]"
              }`}
            >
              {headline}
            </span>
            {tab.dirty ? (
              <span
                className="size-1.5 shrink-0 rounded-full bg-muted-foreground"
                title="Unsaved changes"
                aria-label="Unsaved changes"
              />
            ) : null}
            {tab.thread ? <TabIndicator thread={tab.thread} /> : null}
          </span>
          {meta ? (
            <span className="hidden min-w-0 truncate text-[11px] leading-none text-muted-foreground @min-[11rem]:block">
              {meta}
            </span>
          ) : null}
        </span>
      </button>
      {closable ? (
        <button
          type="button"
          title="Close Tab"
          aria-label={`Close ${headline}`}
          data-no-drag
          data-tauri-drag-region="false"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onClose(tab.id);
          }}
          className="pressable absolute right-1 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted-foreground opacity-0 hover:bg-foreground/7 hover:text-foreground group-hover:opacity-100"
        >
          <X className="size-3.5" strokeWidth={1.75} />
        </button>
      ) : null}
    </div>
  );
}

function GroupLabel({
  color,
  collapsed,
  project,
  projectKey,
  mascotName,
  count,
  logoPath,
  canDrag,
  onToggle,
  menuId,
  onPointerDown,
  consumeClick,
  dropTarget,
  labelRef,
}: {
  color: string;
  collapsed: boolean;
  project: string;
  projectKey: string;
  mascotName: string | null;
  count: number;
  logoPath?: string | null;
  canDrag: boolean;
  onToggle: () => void;
  /** The strip's one context menu reads the group's menu from this. */
  menuId: string;
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  consumeClick: () => boolean;
  dropTarget?: TabDropTarget | null;
  labelRef?: (el: HTMLButtonElement | null) => void;
}) {
  return (
    <button
      ref={labelRef}
      type="button"
      aria-label={collapsed ? `Expand ${project}` : `Collapse ${project}`}
      aria-expanded={!collapsed}
      data-tauri-drag-region="false"
      onClick={() => {
        if (consumeClick()) return;
        onToggle();
      }}
      data-menu-id={menuId}
      onPointerDown={onPointerDown}
      className={`relative sticky left-0 z-20 flex h-7 max-w-36 shrink-0 cursor-default items-center gap-1.5 self-center rounded-md px-2 pr-3 text-[11px] font-medium hover:brightness-110 ${
        canDrag ? "touch-none" : ""
      }`}
      style={{
        background: `color-mix(in srgb, ${color} 20%, var(--color-sidebar) 80%)`,
      }}
    >
      {dropTarget ? (
        <span
          className={`pointer-events-none absolute inset-0 rounded-md ${dropTargetTint(dropTarget)}`}
        />
      ) : null}
      {logoPath ? (
        <ProjectLogoIcon
          path={logoPath}
          className="size-3.5 shrink-0 rounded-md"
          imageClassName="size-3.5"
        />
      ) : (
        <ProjectMascot
          project={projectKey}
          color={color}
          name={mascotName}
          className="size-3 min-w-3 shrink-0"
        />
      )}
      <span className="text-[13px] truncate">{project}</span>
      {collapsed ? (
        <span className="shrink-0 pl-1 text-muted-foreground tabular-nums">
          {count}
        </span>
      ) : null}
    </button>
  );
}

function TabGroupBlock({
  segmentIndex,
  segment,
  displayColor,
  displayLabel,
  projectKey,
  mascotName,
  logoPath,
  activeId,
  closable,
  canDrag,
  canDragGroup,
  sortable,
  segmentDrag,
  collapsed,
  dropTarget,
  onSelect,
  onClose,
  onToggleCollapse,
  deckLayout = false,
}: {
  segmentIndex: number;
  segment: Extract<TabGroupSegment, { kind: "group" }>;
  displayColor: string;
  displayLabel: string;
  projectKey: string;
  mascotName: string | null;
  logoPath?: string | null;
  activeId: string;
  closable: boolean;
  canDrag: boolean;
  canDragGroup: boolean;
  sortable: SortableApi;
  segmentDrag: SegmentDragApi;
  collapsed: boolean;
  dropTarget?: TabDropTarget | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onToggleCollapse: () => void;
  deckLayout?: boolean;
}) {
  const activeInGroup = segment.tabs.some((tab) => tab.id === activeId);
  const activeTabRef = useRef<HTMLDivElement | null>(null);
  const draggingGroup = segmentDrag.draggingFromIndex === segmentIndex;
  const showSegmentStart =
    canDragGroup &&
    segmentDrag.draggingFromIndex != null &&
    segmentDrag.toIndex === segmentIndex &&
    segmentDrag.toIndex < segmentDrag.draggingFromIndex;
  const showSegmentEnd =
    canDragGroup &&
    segmentDrag.draggingFromIndex != null &&
    segmentDrag.toIndex === segmentIndex &&
    segmentDrag.toIndex > segmentDrag.draggingFromIndex;

  useEffect(() => {
    if (
      sortable.draggingId ||
      segmentDrag.draggingFromIndex != null ||
      collapsed
    ) {
      return;
    }
    if (activeInGroup) {
      activeTabRef.current?.scrollIntoView({
        inline: "nearest",
        block: "nearest",
      });
    }
  }, [
    activeId,
    activeInGroup,
    collapsed,
    segmentDrag.draggingFromIndex,
    sortable.draggingId,
  ]);

  return (
    <div
      ref={(el) => segmentDrag.setSegmentRef(segmentIndex, el)}
      className={`relative flex h-full cursor-default items-center gap-0.5 ${
        deckLayout ? "min-w-0 flex-1" : "shrink-0"
      } ${draggingGroup ? "opacity-40" : ""}`}
      data-tauri-drag-region="false"
    >
      {showSegmentStart ? (
        <div className="pointer-events-none absolute inset-y-1.5 left-0 z-30 w-0.5 rounded-full bg-accent" />
      ) : null}
      {showSegmentEnd ? (
        <div className="pointer-events-none absolute inset-y-1.5 right-0 z-30 w-0.5 rounded-full bg-accent" />
      ) : null}
      <GroupLabel
        color={displayColor}
        collapsed={collapsed}
        project={displayLabel}
        projectKey={projectKey}
        mascotName={mascotName}
        count={segment.tabs.length}
        logoPath={logoPath}
        canDrag={canDragGroup}
        dropTarget={dropTarget}
        labelRef={(el) => sortable.setGroupDropRef(segment.key, el)}
        onToggle={onToggleCollapse}
        menuId={`${GROUP_MENU}${segment.key}`}
        consumeClick={segmentDrag.consumeClick}
        onPointerDown={(event) => {
          if (!canDragGroup) return;
          segmentDrag.onSegmentPointerDown(segmentIndex, event);
        }}
      />
      {collapsed ? null : (
        <>
          {segment.tabs.map((tab, offset) => {
            const index = segment.startIndex + offset;
            const position: TabGroupPosition =
              segment.tabs.length === 1
                ? "only"
                : offset === 0
                  ? "first"
                  : offset === segment.tabs.length - 1
                    ? "last"
                    : "middle";
            return (
              <TitleTabItem
                key={tab.id}
                tab={tab}
                index={index}
                active={tab.id === activeId}
                closable={closable}
                canDrag={canDrag}
                sortable={sortable}
                onSelect={onSelect}
                onClose={onClose}
                dropTarget={dropTargetFor(sortable.dropTarget, "tab", tab.id)}
                groupPosition={position}
                deckLayout={deckLayout}
                itemRef={
                  tab.id === activeId
                    ? (el) => {
                        activeTabRef.current = el;
                      }
                    : undefined
                }
              />
            );
          })}
        </>
      )}
      <span
        className="pointer-events-none absolute inset-x-1 bottom-1 z-20 h-0.5 rounded-full"
        style={{ background: displayColor }}
        aria-hidden
      />
    </div>
  );
}

function TabStripChevron({
  side,
  onClick,
}: {
  side: "left" | "right";
  onClick: () => void;
}) {
  const label = side === "left" ? "Scroll tabs left" : "Scroll tabs right";
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-tauri-drag-region="false"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onClick}
      className={`pressable absolute top-5 z-40 grid size-6 -translate-y-1/2 place-items-center rounded-md border border-border bg-background text-muted-foreground hover:text-foreground ${
        side === "left" ? "left-1" : "right-1"
      }`}
    >
      <Icon className="size-3.5" strokeWidth={1.75} />
    </button>
  );
}

export function IconButton({
  label,
  active,
  accent,
  disabled,
  onClick,
  intent,
  children,
}: {
  label: string;
  active?: boolean;
  accent?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  /** Hover or focus warms the chunk the click opens (lib/lazyChunk.tsx). */
  intent?: IntentProps;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      {...intent}
      title={label}
      aria-label={label}
      aria-pressed={active || accent}
      aria-disabled={disabled}
      data-tauri-drag-region="false"
      onClick={() => {
        if (disabled) return;
        onClick?.();
      }}
      className={`pressable grid size-6 place-items-center rounded-md ${
        disabled
          ? "text-muted-foreground opacity-40"
          : accent
            ? "text-accent hover:bg-foreground/7"
            : active
              ? "text-foreground hover:bg-foreground/7"
              : "text-muted-foreground hover:bg-foreground/7 hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

export function DevModeLabel() {
  if (!import.meta.env.DEV) return null;
  return (
    <span
      title="Development build"
      className="mr-1 min-w-0 truncate rounded-md bg-skill/15 px-1.5 py-0.5 text-[11px] font-medium tracking-wide text-skill"
    >
      Development
    </span>
  );
}

/** Flex spacer that keeps the Development badge next to the visit arrows. */
export function DevModeSlot() {
  return (
    <div className="flex min-w-0 flex-1 items-center justify-end">
      <DevModeLabel />
    </div>
  );
}

export function TabVisitNav({
  canGoBack = false,
  canGoForward = false,
  onGoBack,
  onGoForward,
  onTogglePanel,
  panelActive = false,
  panelLabel = "Toggle Projects",
}: {
  canGoBack?: boolean;
  canGoForward?: boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
  onTogglePanel?: () => void;
  panelActive?: boolean;
  panelLabel?: string;
}) {
  return (
    <div className="flex shrink-0 items-center">
      <IconButton
        label={`Back (${MOD}[)`}
        disabled={!canGoBack}
        onClick={onGoBack}
      >
        <ChevronLeft className="size-3.5" strokeWidth={1.75} />
      </IconButton>
      <IconButton
        label={`Forward (${MOD}])`}
        disabled={!canGoForward}
        onClick={onGoForward}
      >
        <ChevronRight className="size-3.5" strokeWidth={1.75} />
      </IconButton>
      {onTogglePanel ? (
        <IconButton
          label={panelLabel}
          active={panelActive}
          onClick={onTogglePanel}
        >
          <PanelLeft className="size-3.5" strokeWidth={1.75} />
        </IconButton>
      ) : null}
    </div>
  );
}

/** Back + rail toggle for overlay surfaces when the project rail is closed. */
export function OverlayNav({
  onBack,
  onToggleSidebar,
}: {
  onBack?: () => void;
  onToggleSidebar?: () => void;
}) {
  if (!onBack && !onToggleSidebar) return null;
  return (
    <div className="flex shrink-0 items-center px-2">
      {onBack ? (
        <IconButton label={`Back (${MOD}[)`} onClick={onBack}>
          <ChevronLeft className="size-3.5" strokeWidth={1.75} />
        </IconButton>
      ) : null}
      {onToggleSidebar ? (
        <IconButton
          label={`Toggle Sidebar (${MOD}B)`}
          onClick={onToggleSidebar}
        >
          <PanelLeft className="size-3.5" strokeWidth={1.75} />
        </IconButton>
      ) : null}
    </div>
  );
}

function TitleBarComponent({
  tabs,
  activeId,
  cwd,
  gitCwd,
  deckLayout = false,
  sourceControlActive = false,
  onToggleSidebar,
  onShowSourceControl,
  onSelect,
  canGoBack = false,
  canGoForward = false,
  onGoBack,
  onGoForward,
  onNew,
  onNewTerminal,
  onShowTerminal,
  projectTerminalActive = false,
  onOpenSettings,
  onOpenInbox,
  onOpenNotes,
  onClose,
  onReorder,
  onGoToFile,
  onJoinTab,
  onJoinTabToGroup,
  onAddToNewGroup,
  onAddToGroup,
  onRemoveFromGroup,
  onUngroup,
  onGroupNewTab,
  header,
  onGroupClose,
  onGroupMoveToNewWindow,
  recents = [],
  onSelectProject,
}: Props) {
  const sidebarPref = useShell((s) => s.sidebarOpen);
  const projectRailOpen = useShell((s) => s.projectRailOpen);
  // Deck mode always shows the sidebar.
  const sidebarOpen = deckLayout || sidebarPref;
  // Deck mode hands the strip to ThreadHeader: chips that never close, a
  // shelf below, no drag. Segments only serve the classic strip.
  const tabIds = deckLayout ? [] : tabs.map((tab) => tab.id);
  const segments = deckLayout ? [] : segmentTabs(tabs);
  const canDragSegments = !deckLayout && segments.length > 1;
  const projectOf = (id: string) => tabs.find((tab) => tab.id === id)?.project;
  const sortable = useSortable(
    tabIds,
    onReorder,
    deckLayout
      ? {}
      : {
          onDropOnItem: onJoinTab,
          onDropOnGroup: onJoinTabToGroup,
          // Tab groups are project-scoped; a foreign drop is flagged, not applied.
          canDropOn: (draggedId, kind, id) =>
            kind === "group"
              ? canJoinTabGroup(tabs, draggedId, id, projectOf)
              : canJoinTabOnto(tabs, draggedId, id, projectOf),
        },
  );
  const segmentDrag = useSegmentDrag(segments.length, (fromIndex, toIndex) => {
    const valid = reorderTabSegments(tabs, fromIndex, toIndex);
    if (valid) onReorder(valid);
  });
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const tabStripRef = useRef<HTMLDivElement | null>(null);
  const setTabStripRef = useCallback(
    (el: HTMLDivElement | null) => {
      tabStripRef.current = el;
      lockOverscroll(el);
    },
    [lockOverscroll],
  );
  const [tabOverflow, setTabOverflow] = useState({ left: false, right: false });
  const syncTabOverflow = useCallback(() => {
    const el = tabStripRef.current;
    const next = el
      ? tabStripOverflow(el.scrollLeft, el.clientWidth, el.scrollWidth)
      : { left: false, right: false };
    setTabOverflow((prev) =>
      prev.left === next.left && prev.right === next.right ? prev : next,
    );
  }, []);
  const scrollTabsBy = useCallback((direction: -1 | 1) => {
    const el = tabStripRef.current;
    if (!el) return;
    const amount = Math.max(el.clientWidth * 0.6, 112);
    el.scrollBy({ left: direction * amount, behavior: "smooth" });
  }, []);
  const activeTabRef = useRef<HTMLDivElement | null>(null);
  const closable = !deckLayout && tabs.length > 1;
  const canDrag = !deckLayout && tabs.length > 1;
  const [collapsedGroups, setCollapsedGroups] = useState(
    loadCollapsedTabGroups,
  );
  const [groupColors, setGroupColors] = useState(loadTabGroupColors);
  const [groupCustomColors, setGroupCustomColors] = useState(
    loadTabGroupCustomColors,
  );
  const [groupLabels, setGroupLabels] = useState(loadTabGroupLabels);
  useEffect(() => {
    const refresh = () => setGroupLabels(loadTabGroupLabels());
    window.addEventListener(TAB_GROUP_LABELS_CHANGED, refresh);
    return () => window.removeEventListener(TAB_GROUP_LABELS_CHANGED, refresh);
  }, []);
  const [groupLogos, setGroupLogos] = useState(loadTabGroupLogos);
  const [groupMascots, setGroupMascots] = useState(loadTabGroupMascots);
  const [confirmGroupClose, setConfirmGroupClose] = useState<{
    label: string;
    tabIds: string[];
  } | null>(null);
  // The group whose Customize dialog is open.
  const [customizing, setCustomizing] = useState<string | null>(null);
  const threadMenu = useThreadMenu({ onScreen: (id) => tabThreadId(activeId) === id });

  const groupSummaries = segments.flatMap((segment) => {
    if (segment.kind !== "group") return [];
    const shared = sharedGroupProject(segment.tabs);
    return [
      {
        id: segment.key,
        label: resolveTabGroupLabel(
          segment.key,
          groupLabels,
          shared || "Group",
        ),
      },
    ];
  });

  const groupMenuTabs = customizing
    ? tabs.filter((tab) => tab.groupId === customizing)
    : [];
  const groupMenuShared = sharedGroupProject(groupMenuTabs);
  const groupMenuWorkspaceTabs = workspaceTabsStore.getState().tabs.filter((tab) =>
    groupMenuTabs.some((menuTab) => menuTab.id === tab.id),
  );
  const groupMenuSession = groupMenuWorkspaceTabs
    .flatMap((tab) => [tab.focusedId, ...leafIds(tab.layout)])
    .map((id) => sessionStore.get(id))
    .find((session) => session !== undefined);
  const groupMenuCwd = groupMenuSession?.cwd ?? groupMenuWorkspaceTabs
    .flatMap((tab) => [...tab.editorPanes, ...(tab.terminalPanes ?? [])])
    .flatMap((pane) => pane.files).find((file) => file.cwd)?.cwd ?? cwd;

  const toggleGroupCollapse = useCallback((project: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(project)) next.delete(project);
      else next.add(project);
      saveCollapsedTabGroups(next);
      return next;
    });
  }, []);

  const onGroupMenuPick = (action: TabGroupMenuAction, groupId: string) => {
    const tabIds = tabs.filter((tab) => tab.groupId === groupId).map((tab) => tab.id);
    if (action === "new-tab") onGroupNewTab?.(groupId);
    else if (action === "new-window") onGroupMoveToNewWindow?.(tabIds);
    else if (action === "close-group") onGroupClose?.(tabIds);
    else if (action === "ungroup") onUngroup?.(groupId);
    else if (action === "delete-group") {
      const shared = tabs.find((tab) => tab.groupId === groupId)?.project ?? "Group";
      setConfirmGroupClose({ label: resolveTabGroupLabel(groupId, groupLabels, shared), tabIds });
    }
  };

  /** A tab's right-click: its focused thread's rows (lib/threadMenu.ts), then the group rows. */
  const tabMenuRows = (tabId: string | null): MenuRow[] | null => {
    if (tabId?.startsWith(GROUP_MENU)) return groupMenuRows({ actions: true, extra: onGroupNewTab ? NEW_THREAD_ROWS : [] });
    const tab = tabId ? tabs.find((entry) => entry.id === tabId) : undefined;
    if (!tab) return null;
    const threadId = tabThreadId(tab.id);
    const rows: MenuRow[] = threadId ? [...threadMenu.rowsFor(threadId), { kind: "sep" }] : [];
    rows.push({ kind: "item", id: "new-group", label: "Add to new group", icon: FolderPlus });
    const others = groupSummaries.filter(
      (group) =>
        group.id !== tab.groupId &&
        canJoinTabGroup(tabs, tab.id, group.id, projectOf),
    );
    if (others.length > 0) {
      rows.push({ kind: "sep" });
      for (const group of others) rows.push({ kind: "item", id: `add:${group.id}`, label: `Add to ${group.label}`, icon: Folder });
    }
    if (tab.groupId) rows.push({ kind: "sep" }, { kind: "item", id: "remove", label: "Remove from group", icon: Ungroup });
    return tidy(rows);
  };

  const onTabMenuPick = (id: string, tabId: string | null) => {
    if (!tabId) return;
    if (tabId.startsWith(GROUP_MENU)) {
      const groupId = tabId.slice(GROUP_MENU.length);
      const action = groupActionOf(id);
      if (id === CUSTOMIZE) setCustomizing(groupId);
      else if (action) onGroupMenuPick(action, groupId);
      else if (id.startsWith("new:")) onGroupNewTab?.(groupId, id.slice(4) as ThreadType);
      return;
    }
    if (id === "new-group") onAddToNewGroup?.(tabId);
    else if (id === "remove") onRemoveFromGroup?.(tabId);
    else if (id.startsWith("add:")) onAddToGroup?.(tabId, id.slice(4));
    else {
      const threadId = tabThreadId(tabId);
      if (threadId) threadMenu.onPick(threadId, id);
    }
  };

  const onGroupRename = useCallback((projectKey: string, label: string) => {
    saveTabGroupLabel(projectKey, label);
    setGroupLabels(loadTabGroupLabels());
  }, []);

  const onGroupMascotChange = useCallback(
    (projectKey: string, name: string | null) => {
      saveTabGroupMascot(projectKey, name);
      setGroupMascots(loadTabGroupMascots());
    },
    [],
  );

  const onGroupColorChange = useCallback(
    (projectKey: string, colorIndex: number | null) => {
      saveTabGroupColor(projectKey, colorIndex);
      setGroupColors(loadTabGroupColors());
      setGroupCustomColors(loadTabGroupCustomColors());
    },
    [],
  );

  const onGroupCustomColorChange = useCallback(
    (projectKey: string, color: string) => {
      saveTabGroupCustomColor(projectKey, color);
      setGroupColors(loadTabGroupColors());
      setGroupCustomColors(loadTabGroupCustomColors());
    },
    [],
  );

  const onGroupLogoChange = useCallback(() => {
    setGroupLogos(loadTabGroupLogos());
  }, []);

  useEffect(() => {
    const refresh = () => setGroupLogos(loadTabGroupLogos());
    window.addEventListener(TAB_GROUP_LOGOS_CHANGED, refresh);
    return () => window.removeEventListener(TAB_GROUP_LOGOS_CHANGED, refresh);
  }, []);

  useEffect(() => {
    if (sortable.draggingId || segmentDrag.draggingFromIndex != null) return;
    activeTabRef.current?.scrollIntoView({
      inline: "nearest",
      block: "nearest",
    });
  }, [activeId, segmentDrag.draggingFromIndex, sortable.draggingId]);

  useLayoutEffect(() => {
    const el = tabStripRef.current;
    if (!el) return;
    syncTabOverflow();
    el.addEventListener("scroll", syncTabOverflow, { passive: true });
    const ro = new ResizeObserver(syncTabOverflow);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", syncTabOverflow);
      ro.disconnect();
    };
  }, [syncTabOverflow]);

  useLayoutEffect(() => {
    syncTabOverflow();
  }, [activeId, collapsedGroups, syncTabOverflow, tabs]);

  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeId),
    [activeId, tabs],
  );
  const systemTitle = useMemo(() => {
    const activeName = activeTab
      ? activeTab.files[0]
        ? basename(activeTab.files[0])
        : activeTab.project
      : "";
    const project = cwd ? basename(cwd) : "";
    if (activeName && project && activeName !== project) {
      return `${activeName} — ${project} — TempCode`;
    }
    if (project) {
      return `${project} — TempCode`;
    }
    return "TempCode";
  }, [activeTab, cwd]);

  const railClosed = deckLayout && !projectRailOpen;
  const showCurrentProject = looksLikeProject(cwd);
  // Until a project is picked, deck mode hides the rail and the sidebar, so
  // nothing project-scoped is actionable and the window controls need room.
  const projectless = deckLayout && !showCurrentProject;
  // An open project is labeled in the sidebar, above Sessions / Explorer /
  // Changes. Without a project that sidebar is gone, so the picker stays here.
  const showProjectButton =
    railClosed && Boolean(onSelectProject) && !showCurrentProject;
  const trailingControls = (
    <div className="flex h-10 shrink-0 items-stretch">
      <div className="flex items-center gap-0.5 px-2">
        {!deckLayout ? (
          <ProjectDiffStats
            cwd={gitCwd || cwd}
            active={sourceControlActive}
            onClick={onShowSourceControl}
          />
        ) : null}
        {projectless && railClosed && onOpenInbox ? (
          <IconButton label="Inbox" onClick={onOpenInbox}>
            <Inbox className="size-3.5" strokeWidth={1.75} />
          </IconButton>
        ) : null}
        {projectless && railClosed && onOpenNotes ? (
          <IconButton label="Notes" onClick={onOpenNotes}>
            <StickyNote className="size-3.5" strokeWidth={1.75} />
          </IconButton>
        ) : null}
        {railClosed && !projectless ? (
          <>
            <IconButton label={`Go to File (${MOD}P)`} onClick={onGoToFile}>
              <Search className="size-3.5" strokeWidth={1.75} />
            </IconButton>
            <IconButton label={`New session (${MOD}T)`} onClick={onNew}>
              <Plus className="size-3.5" strokeWidth={1.75} />
            </IconButton>
          </>
        ) : null}
        {/* With the thread header the terminal is a row of its ⋯ menu. */}
        {deckLayout && !header && !projectless && (onShowTerminal || onNewTerminal) ? (
          <IconButton
            label={
              projectTerminalActive ? "Terminal" : `New Terminal (${MOD}\`)`
            }
            accent={projectTerminalActive}
            intent={terminalChunk.intent}
            onClick={
              projectTerminalActive
                ? (onShowTerminal ?? onNewTerminal)
                : onNewTerminal
            }
          >
            <Terminal className="size-3.5" strokeWidth={1.75} />
          </IconButton>
        ) : null}
        {deckLayout &&
        !projectRailOpen &&
        !showCurrentProject &&
        onOpenSettings ? (
          <IconButton label={`Settings (${MOD},)`} onClick={onOpenSettings} intent={settingsChunk.intent}>
            <Settings className="size-3.5" strokeWidth={1.75} />
          </IconButton>
        ) : null}
      </div>
      {!IS_MAC ? <WindowControls /> : null}
    </div>
  );

  // "deep" drags from anywhere in the subtree. The bare attribute only drags
  // on a direct hit, which left every label and spacer dead. Tauri still
  // exempts buttons, links and inputs on its own.
  return (
    <header
      className="flex min-h-10 shrink-0 select-none items-stretch border-b border-border bg-sidebar"
      data-tauri-drag-region="deep"
    >
      {/* Both the rail and the sidebar step aside without a project, so the
          title bar takes over the traffic lights and the rail toggle. */}
      {(projectless && railClosed) || (!sidebarOpen && IS_MAC) ? (
        <div className="w-[78px] shrink-0" />
      ) : null}
      {projectless && railClosed ? (
        <div className="flex h-10 shrink-0 items-center px-2">
          <IconButton
            label={`Toggle Sidebar (${MOD}B)`}
            onClick={onToggleSidebar}
          >
            <PanelLeft className="size-3.5" strokeWidth={1.75} />
          </IconButton>
        </div>
      ) : null}
      {deckLayout ? null : (
        <div className="flex shrink-0 items-center gap-0.5 px-2">
          {sidebarOpen ? null : (
            <>
              <DevModeLabel />
              <TabVisitNav
                canGoBack={canGoBack}
                canGoForward={canGoForward}
                onGoBack={onGoBack}
                onGoForward={onGoForward}
              />
            </>
          )}
          <IconButton
            label={`Toggle Sidebar (${MOD}B)`}
            active={sidebarOpen}
            onClick={onToggleSidebar}
          >
            <PanelLeft className="size-3.5" strokeWidth={1.75} />
          </IconButton>
          <IconButton label={`Go to File (${MOD}P)`} onClick={onGoToFile}>
            <Search className="size-3.5" strokeWidth={1.75} />
          </IconButton>
        </div>
      )}
      {showProjectButton && onSelectProject ? (
        <CwdPicker
          cwd={cwd}
          recents={recents}
          placement="below"
          onCwdChange={onSelectProject}
          onNewTerminal={onNewTerminal}
          buttonClassName="flex h-full min-w-0 max-w-64 shrink items-center gap-2 px-4 text-left text-[13px] font-medium leading-tight"
        >
          <span className="min-w-0 truncate text-muted-foreground">No project</span>
        </CwdPicker>
      ) : null}

      <div
        className={`flex min-w-0 flex-1 items-stretch${
          deckLayout && !showProjectButton ? "" : " border-l border-border"
        }`}
      >
        {/*
          Strip sizes to its tabs (w-56 each), sits left; + follows.
          When crowded, tabs shrink to min-w-28 then the strip scrolls.
        */}
        <div
          className={`relative min-w-0 overflow-hidden ${
            deckLayout ? "flex flex-1" : "h-full shrink"
          }`}
          // A chevron sits over the strip's edge; the strip pads that end by the
          // chevron's width (24px + 4px inset + 4px), so no chip sits under it.
          style={{
            ["--strip-pad-l" as string]: tabOverflow.left ? "32px" : undefined,
            ["--strip-pad-r" as string]: tabOverflow.right ? "32px" : undefined,
          }}
          onWheel={
            deckLayout
              ? undefined
              : (event) => {
                  const el = tabStripRef.current;
                  if (!el || el.scrollWidth <= el.clientWidth) return;
                  if (event.deltaX === 0 && event.deltaY !== 0) {
                    el.scrollLeft += event.deltaY;
                  }
                }
          }
        >
          {tabOverflow.left ? (
            <TabStripChevron side="left" onClick={() => scrollTabsBy(-1)} />
          ) : null}
          {tabOverflow.right ? (
            <TabStripChevron side="right" onClick={() => scrollTabsBy(1)} />
          ) : null}
          {deckLayout && header ? (
            <ThreadHeader
              {...header}
              onShowTerminal={onShowTerminal}
              onNewTerminal={onNewTerminal}
              projectTerminalActive={projectTerminalActive}
              stripRef={setTabStripRef}
              activeRef={(el) => {
                activeTabRef.current = el;
              }}
            />
          ) : (
            <RowsContextMenu
              label="Tab actions"
              rowsFor={tabMenuRows}
              onPick={onTabMenuPick}
              onOpenChange={(open, tabId) => {
                if (!tabId) return;
                if (tabId.startsWith(GROUP_MENU)) customizeChunk.preload();
                else threadMenu.onOpenChange(tabThreadId(tabId), open);
              }}
            >
            <div
              ref={setTabStripRef}
              className="scrollbar-none flex h-full min-w-0 cursor-default items-center gap-0.5 overflow-x-auto overflow-y-hidden overscroll-none pl-[var(--strip-pad-l,8px)] pr-[var(--strip-pad-r,8px)]"
            >
            {segments.map((segment, segmentIndex) => {
              const showSegmentStart =
                canDragSegments &&
                segmentDrag.draggingFromIndex != null &&
                segmentDrag.toIndex === segmentIndex &&
                segmentDrag.toIndex < segmentDrag.draggingFromIndex;
              const showSegmentEnd =
                canDragSegments &&
                segmentDrag.draggingFromIndex != null &&
                segmentDrag.toIndex === segmentIndex &&
                segmentDrag.toIndex > segmentDrag.draggingFromIndex;

              if (segment.kind === "group") {
                const shared = sharedGroupProject(segment.tabs);
                return (
                  <TabGroupBlock
                    key={segment.key}
                    segmentIndex={segmentIndex}
                    segment={segment}
                    displayColor={resolveTabGroupColor(
                      segment.key,
                      groupColors,
                      groupCustomColors,
                      shared || segment.key,
                    )}
                    displayLabel={resolveTabGroupLabel(
                      segment.key,
                      groupLabels,
                      shared || "Group",
                    )}
                    projectKey={shared || segment.key}
                    mascotName={resolveTabGroupMascot(
                      segment.key,
                      groupMascots,
                    )}
                    logoPath={
                      shared ? resolveTabGroupLogo(shared, groupLogos) : null
                    }
                    activeId={activeId}
                    closable={closable}
                    canDrag={canDrag}
                    canDragGroup={canDragSegments}
                    sortable={sortable}
                    segmentDrag={segmentDrag}
                    collapsed={collapsedGroups.has(segment.key)}
                    dropTarget={dropTargetFor(
                      sortable.dropTarget,
                      "group",
                      segment.key,
                    )}
                    onSelect={onSelect}
                    onClose={onClose}
                    onToggleCollapse={() => toggleGroupCollapse(segment.key)}
                    deckLayout={deckLayout}
                  />
                );
              }

              const tab = segment.tab;
              const active = tab.id === activeId;
              const draggingSegment =
                segmentDrag.draggingFromIndex === segmentIndex;
              return (
                <div
                  key={tab.id}
                  ref={(el) => segmentDrag.setSegmentRef(segmentIndex, el)}
                  className={`relative flex h-full cursor-default items-center ${
                    deckLayout ? "w-56 min-w-28 shrink" : "shrink-0"
                  } ${draggingSegment ? "opacity-40" : ""}`}
                  data-tauri-drag-region="false"
                >
                  {showSegmentStart ? (
                    <div className="pointer-events-none absolute inset-y-1.5 left-0 z-30 w-0.5 rounded-full bg-accent" />
                  ) : null}
                  {showSegmentEnd ? (
                    <div className="pointer-events-none absolute inset-y-1.5 right-0 z-30 w-0.5 rounded-full bg-accent" />
                  ) : null}
                  <TitleTabItem
                    tab={tab}
                    index={segment.index}
                    active={active}
                    closable={closable}
                    canDrag={canDrag}
                    sortable={sortable}
                    onSelect={onSelect}
                    onClose={onClose}
                        dropTarget={dropTargetFor(
                      sortable.dropTarget,
                      "tab",
                      tab.id,
                    )}
                    deckLayout={deckLayout}
                    itemRef={
                      tab.id === activeId
                        ? (el) => {
                            activeTabRef.current = el;
                          }
                        : undefined
                    }
                  />
                </div>
              );
            })}
            </div>
            </RowsContextMenu>
          )}
        </div>

        {customizing ? (
          <CustomizeGroupDialog
            environmentId={groupMenuSession?.environmentId ?? environmentOfCwd(groupMenuCwd) ?? registry.primary().environmentId}
            groupId={customizing}
            label={resolveTabGroupLabel(customizing, groupLabels, groupMenuShared || "Group")}
            colorIndex={resolveTabGroupColorIndex(customizing, groupColors, groupCustomColors)}
            customColor={resolveTabGroupCustomColor(customizing, groupCustomColors)}
            currentColor={resolveTabGroupColor(customizing, groupColors, groupCustomColors, groupMenuShared || customizing)}
            logoPath={groupMenuShared ? resolveTabGroupLogo(groupMenuShared, groupLogos) : null}
            logoProject={groupMenuShared || null}
            mascotName={resolveTabGroupMascot(customizing, groupMascots)}
            mascotProject={groupMenuShared || customizing}
            onSave={(look) => {
              onGroupRename(customizing, look.name);
              if (look.customColor) onGroupCustomColorChange(customizing, look.customColor);
              else onGroupColorChange(customizing, look.colorIndex);
              onGroupMascotChange(customizing, look.mascot);
            }}
            onLogoChange={onGroupLogoChange}
            onClose={() => setCustomizing(null)}
          />
        ) : null}

        {confirmGroupClose ? (
          <ConfirmDialog
            title={`Delete “${confirmGroupClose.label}”?`}
            body={`Its ${confirmGroupClose.tabIds.length} tabs close.`}
            confirmLabel="Delete"
            danger
            onCancel={() => setConfirmGroupClose(null)}
            onConfirm={() => {
              onGroupClose?.(confirmGroupClose.tabIds);
              setConfirmGroupClose(null);
            }}
          />
        ) : null}

        {threadMenu.dialogs}

        {/* Deck mode keeps New in the sidebar and Terminal in the title bar,
            so the strip carries no trailing actions. */}
        {deckLayout ? null : (
          <div className="flex shrink-0 items-center gap-0.5 border-l border-border px-2">
            <IconButton label={`New Tab (${MOD}N)`} onClick={onNew}>
              <Plus className="size-3.5" strokeWidth={1.75} />
            </IconButton>
            {onNewTerminal ? (
              <IconButton
                label={`New Terminal (${MOD}\`)`}
                onClick={onNewTerminal}
              >
                <Terminal className="size-3.5" strokeWidth={1.75} />
              </IconButton>
            ) : null}
          </div>
        )}

        {deckLayout && IS_MAC ? null : (
          <div className="flex min-w-0 flex-1 items-center justify-center px-4">
            {!IS_MAC ? (
              <span className="pointer-events-none truncate text-[12px] font-medium text-muted-foreground select-none">
                {systemTitle}
              </span>
            ) : null}
          </div>
        )}
        {trailingControls}
      </div>
    </header>
  );
}

export const TitleBar = memo(TitleBarComponent);

function ProjectDiffStats({
  cwd,
  active,
  onClick,
}: {
  cwd: string;
  active: boolean;
  onClick?: () => void;
}) {
  const enabled = Boolean(cwd) && cwd !== "~" && Boolean(onClick);
  const stats = useProjectDiffStats(cwd, enabled);
  if (!enabled) return null;

  const files = stats?.files ?? 0;
  const additions = stats?.additions ?? 0;
  const deletions = stats?.deletions ?? 0;
  const hasStats = additions > 0 || deletions > 0;
  const label = hasStats
    ? [
        `${files} ${files === 1 ? "file" : "files"} changed`,
        additions > 0 ? `+${additions}` : "",
        deletions > 0 ? `−${deletions}` : "",
      ]
        .filter(Boolean)
        .join(" ")
    : active
      ? "Hide changes"
      : "Show changes";

  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      data-tauri-drag-region="false"
      onClick={onClick}
      {...diffChunk.intent}
      className={`pressable flex h-6 items-center gap-1 rounded-md ${
        hasStats
          ? "px-1.5 font-mono text-[11px] font-semibold tabular-nums"
          : "w-6 justify-center"
      } ${
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-foreground/7 hover:text-foreground"
      }`}
    >
      {hasStats ? null : (
        <GitCompare className="size-3.5 shrink-0" strokeWidth={1.75} />
      )}
      {additions > 0 ? (
        <span className="text-success">+{additions}</span>
      ) : null}
      {deletions > 0 ? (
        <span className="text-danger">−{deletions}</span>
      ) : null}
    </button>
  );
}
