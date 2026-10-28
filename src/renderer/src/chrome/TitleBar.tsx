import {
  ChevronLeft,
  ChevronRight,
  Inbox,
  PanelLeft,
  Plus,
  Search,
  Settings,
  StickyNote,
} from "./icons";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { basename } from "../lib/fs";
import { looksLikeProject } from "../lib/recents";
import type { HarnessId } from "../lib/session";
import { CwdPicker } from "./CwdPicker";
import { shortcutFor } from "../lib/settings";
import { Tip } from "../components/tip";
import { Button } from "../components/ui/button";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import type { TabThread } from "./TabIndicator";
import { ThreadHeader, type ThreadHeaderProps } from "./ThreadHeader";
import { WindowControls } from "./WindowControls";
import { IS_MAC } from "../lib/platform";
import type { RecentProject } from "../lib/recents";
import { useShell } from "../stores/shell";
import type { IntentProps } from "../lib/lazyChunk";
import { settingsChunk } from "../surfaces/chunks";

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

type Props = {
  tabs: Tab[];
  activeId: string;
  cwd: string;
  onToggleSidebar: () => void;
  onNew: () => void;
  onNewTerminal?: () => void;
  onShowTerminal?: () => void;
  projectTerminalActive?: boolean;
  onOpenSettings?: () => void;
  onOpenInbox?: () => void;
  onOpenNotes?: () => void;
  onGoToFile?: () => void;
  /** temp-code's thread strip and heading controls. */
  header: ThreadHeaderProps;
  recents?: RecentProject[];
  onSelectProject?: (path: string) => void;
  /** "Choose folder…" in the no-project picker. */
  onChooseFolder?: () => void;
};

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
    <Tip label={label} side="bottom">
      <Button
        variant="outline"
        size="icon-xs"
        aria-label={label}
        data-tauri-drag-region="false"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={onClick}
        className={`absolute top-5 z-40 -translate-y-1/2 bg-background text-muted-foreground hover:text-foreground ${side === "left" ? "left-1" : "right-1"}`}
      >
        <Icon className="size-3.5" strokeWidth={1.75} />
      </Button>
    </Tip>
  );
}

export function IconButton({
  label,
  shortcut,
  active,
  accent,
  disabled,
  onClick,
  intent,
  children,
}: {
  /** Its name, on hover and to a screen reader. */
  label: string;
  /** Its binding's key cap (`shortcutFor`). */
  shortcut?: string;
  active?: boolean;
  accent?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  /** Hover or focus warms the chunk the click opens (lib/lazyChunk.tsx). */
  intent?: IntentProps;
  children: ReactNode;
}) {
  return (
    <Tip label={label} shortcut={shortcut} side="bottom">
      <Button
        variant="ghost"
        size="icon-xs"
        {...intent}
        aria-label={label}
        aria-pressed={active || accent}
        aria-disabled={disabled}
        data-tauri-drag-region="false"
        onClick={() => {
          if (disabled) return;
          onClick?.();
        }}
        className={
          disabled
            ? "text-muted-foreground opacity-40"
            : accent
              ? "text-accent"
              : active
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
        }
      >
        {children}
      </Button>
    </Tip>
  );
}

export function DevModeLabel() {
  if (!import.meta.env.DEV) return null;
  return (
    <span
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
  panelLabel = "Workspaces",
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
        label="Back"
        shortcut={shortcutFor("Tabs", "Back")}
        disabled={!canGoBack}
        onClick={onGoBack}
      >
        <ChevronLeft className="size-3.5" strokeWidth={1.75} />
      </IconButton>
      <IconButton
        label="Forward"
        shortcut={shortcutFor("Tabs", "Forward")}
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
        <IconButton label="Back" shortcut={shortcutFor("Tabs", "Back")} onClick={onBack}>
          <ChevronLeft className="size-3.5" strokeWidth={1.75} />
        </IconButton>
      ) : null}
      {onToggleSidebar ? (
        <IconButton
          label="Sidebar"
            shortcut={shortcutFor("App", "Sidebar")}
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
  onToggleSidebar,
  onNew,
  onNewTerminal,
  onShowTerminal,
  projectTerminalActive = false,
  onOpenSettings,
  onOpenInbox,
  onOpenNotes,
  onGoToFile,
  header,
  recents = [],
  onSelectProject,
  onChooseFolder,
}: Props) {
  const projectRailOpen = useShell((s) => s.projectRailOpen);
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

  useEffect(() => {
    activeTabRef.current?.scrollIntoView({
      inline: "nearest",
      block: "nearest",
    });
  }, [activeId]);

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
  }, [activeId, syncTabOverflow, tabs]);

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

  const railClosed = !projectRailOpen;
  const showCurrentProject = looksLikeProject(cwd);
  // Until a project is picked the rail steps aside, so nothing
  // project-scoped is actionable and the window controls need room.
  const projectless = !showCurrentProject;
  // An open project is labeled in the rail. Without a project the rail is
  // gone, so the picker stays here.
  const showProjectButton =
    railClosed && Boolean(onSelectProject) && !showCurrentProject;
  const trailingControls = (
    <div className="flex h-10 shrink-0 items-stretch">
      <div className="flex items-center gap-0.5 px-2">
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
            <IconButton label="Go to file" shortcut={shortcutFor("App", "Go to File")} onClick={onGoToFile}>
              <Search className="size-3.5" strokeWidth={1.75} />
            </IconButton>
            <IconButton label="New thread" shortcut={shortcutFor("Tabs", "New Thread")} onClick={onNew}>
              <Plus className="size-3.5" strokeWidth={1.75} />
            </IconButton>
          </>
        ) : null}
        {!projectRailOpen && !showCurrentProject && onOpenSettings ? (
          <IconButton label="Settings" shortcut={shortcutFor("App", "Settings")} onClick={onOpenSettings} intent={settingsChunk.intent}>
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
      {/* The rail steps aside without a project, so the title bar takes over
          the traffic lights and the rail toggle. */}
      {projectless && railClosed ? (
        <>
          <div className="w-[78px] shrink-0" />
          <div className="flex h-10 shrink-0 items-center px-2">
            <IconButton
              label="Sidebar"
              shortcut={shortcutFor("App", "Sidebar")}
              onClick={onToggleSidebar}
            >
              <PanelLeft className="size-3.5" strokeWidth={1.75} />
            </IconButton>
          </div>
        </>
      ) : null}
      {showProjectButton && onSelectProject ? (
        <CwdPicker
          cwd={cwd}
          recents={recents}
          placement="below"
          onCwdChange={onSelectProject}
          onChooseFolder={onChooseFolder}
          onNewTerminal={onNewTerminal}
          buttonClassName="flex h-full min-w-0 max-w-64 shrink items-center gap-2 px-4 text-left text-[13px] font-medium leading-tight"
        >
          <span className="min-w-0 truncate text-muted-foreground">No project</span>
        </CwdPicker>
      ) : null}

      <div
        className={`flex min-w-0 flex-1 items-stretch${
          showProjectButton ? " border-l border-border" : ""
        }`}
      >
        <div
          className="relative flex min-w-0 flex-1 overflow-hidden"
          // A chevron sits over the strip's edge; the strip pads that end by the
          // chevron's width (24px + 4px inset + 4px), so no chip sits under it.
          style={{
            ["--strip-pad-l" as string]: tabOverflow.left ? "32px" : undefined,
            ["--strip-pad-r" as string]: tabOverflow.right ? "32px" : undefined,
          }}
        >
          {tabOverflow.left ? (
            <TabStripChevron side="left" onClick={() => scrollTabsBy(-1)} />
          ) : null}
          {tabOverflow.right ? (
            <TabStripChevron side="right" onClick={() => scrollTabsBy(1)} />
          ) : null}
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
        </div>

        {IS_MAC ? null : (
          <div className="flex min-w-0 flex-1 items-center justify-center px-4">
            <span className="pointer-events-none truncate text-[12px] font-medium text-muted-foreground select-none">
              {systemTitle}
            </span>
          </div>
        )}
        {trailingControls}
      </div>
    </header>
  );
}

export const TitleBar = memo(TitleBarComponent);
