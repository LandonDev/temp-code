import type { ComposerIntent } from "../lib/composerAction";
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { OpenFileFn } from "../lib/search";
import { setGrabbing, suppressTextSelection } from "../lib/drag";
import {
  paneDropFromPoint,
  useExternalPaneDrop,
} from "../lib/paneDrop";
import type { ApprovalDecision } from "../lib/harness";
import { PaneVisibilityContext } from "../hooks/paneVisibility";
import { useSidebarLayout } from "../hooks/useSidebarLayout";
import {
  layoutLeaves,
  layoutSashes,
  leaf,
  setSplitRatio,
  type LayoutNode,
  type LayoutSash,
  type PaneEdge,
  type WorkspaceTab,
} from "../lib/layout";
import type { RecentProject } from "../lib/recents";
import type { TerminalMetaPatch } from "../lib/terminalTab";
import { tabSurfacePanes } from "../lib/workspaceFocus";
import { useEditors } from "../stores/editors";
import { useFocus } from "../stores/focus";
import { useProject } from "../stores/project";
import { useWorkspaceTabs } from "../stores/workspace";
import type {
  Attachment,
  Block,
  HarnessId,
  RuntimeMode,
  Session,
} from "../lib/session";
import { sessionStore, useSession } from "../lib/tcserver/store";
import type { ThreadType } from "../lib/tcserver/types";
import { FilePane } from "./FilePane";
import { holdWhileHidden, paneTreePropsEqual } from "./paneTreeProps";
import { SessionPane } from "./SessionPane";

type Props = {
  tabId: string;
  visible: boolean;
  onFocus: (paneId: string) => void;
  onClose: (sessionId: string) => void;
  onSelectFile: (paneId: string, fileId: string) => void;
  onCloseFile: (paneId: string, fileId: string) => void;
  onReorderFiles: (paneId: string, ids: string[]) => void;
  onFileDirtyChange: (fileId: string, dirty: boolean) => void;
  onFileErrorCountChange: (fileId: string, count: number) => void;
  onRatio: (tabId: string, splitId: string, index: number, ratio: number) => void;
  onCwdChange: (sessionId: string, cwd: string) => void;
  onBranchChange: (sessionId: string) => void;
  onModelChange: (sessionId: string, harness: HarnessId, model: string) => void;
  onModelSettingsChange: (
    sessionId: string,
    settings: Record<string, string>,
  ) => void;
  onRuntimeModeChange: (sessionId: string, mode: RuntimeMode) => void;
  onThreadTypeChange: (sessionId: string, type: ThreadType) => void;
  onSubmit: (
    sessionId: string,
    text: string,
    attachments: Attachment[],
    options?: { newPass?: boolean; intent?: ComposerIntent },
  ) => void;
  onStop: (sessionId: string) => void;
  onInboxCardDismiss?: (sessionId: string) => void;
  onNoteCardDismiss?: (sessionId: string) => void;
  onHandoffCardDismiss?: (sessionId: string) => void;
  onApproval: (
    sessionId: string,
    requestId: string | number,
    decision: ApprovalDecision,
  ) => void;
  onOpenFile: OpenFileFn;
  onOpenDiff: (path?: string) => void;
  onShowSourceControl?: () => void;
  onOpenSession?: (sessionId: string) => void;
  onSecondOpinion?: (
    sessionId: string,
    harness: HarnessId,
    turn: Block[],
    model: string,
  ) => void;
  onHandoff?: (
    sessionId: string,
    harness: HarnessId,
    turn: Block[],
    model: string,
  ) => void;
  onMovePane: (fromId: string, toId: string, edge: PaneEdge) => void;
  onNewTerminal: (sessionId: string) => void;
  onTerminalMetaChange?: (fileId: string, patch: TerminalMetaPatch) => void;
};

type PaneDrag = {
  fromId: string;
  overId: string | null;
  edge: PaneEdge;
};

const DRAG_THRESHOLD = 5;

type SessionLeafProps = Omit<ComponentProps<typeof SessionPane>, "session"> & { id: string };

/** One conversation pane, subscribed to its own session so a change in any
 *  other session (or a streamed turn elsewhere) never reaches this subtree.
 *
 *  That subscription bypasses `PaneTree`'s own `paneTreePropsEqual` memo
 *  (a store notification re-renders this leaf directly, not through a
 *  parent prop), so a parked tab whose session is busy would otherwise
 *  hand `SessionPane` a fresh object on every streamed token and force it
 *  to reconcile a transcript nobody can see — the cost scales with how
 *  many mounted-but-hidden tabs are streaming at once. `holdWhileHidden`
 *  closes that gap the same way `paneTreePropsEqual` does for props: while
 *  `visible` is false, this keeps handing `SessionPane` the same frozen
 *  reference, so its memo bails out and the subtree does nothing until
 *  the tab is shown again. */
function SessionLeaf({ id, visible, ...props }: SessionLeafProps) {
  const live = useSession(id);
  const frozen = useRef<Session | undefined>(undefined);
  const session = holdWhileHidden(visible, live, frozen.current);
  if (visible) frozen.current = live;
  // A tab restored at launch carries its meta only; the transcript arrives
  // once the pane is on the page (only the warm set of tabs mounts).
  useEffect(() => {
    void sessionStore.ensureLoaded(id);
  }, [id]);
  if (!session) return null;
  return <SessionPane session={session} visible={visible} {...props} />;
}

const NO_DIRTY = new Set<string>();
const NO_COUNTS = new Map<string, number>();
const NO_RECENTS: RecentProject[] = [];

/** Nothing to draw while a closed tab's tree unmounts. */
const NO_TAB: WorkspaceTab = {
  kind: "session",
  id: "",
  layout: leaf(""),
  focusedId: "",
  editorPanes: [],
  terminalPanes: [],
};

function PaneTreeComponent({
  tabId,
  visible,
  onFocus,
  onClose,
  onSelectFile,
  onCloseFile,
  onReorderFiles,
  onFileDirtyChange,
  onFileErrorCountChange,
  onRatio,
  onCwdChange,
  onBranchChange,
  onModelChange,
  onModelSettingsChange,
  onRuntimeModeChange,
  onThreadTypeChange,
  onSubmit,
  onStop,
  onInboxCardDismiss,
  onNoteCardDismiss,
  onHandoffCardDismiss,
  onApproval,
  onOpenFile,
  onOpenDiff,
  onShowSourceControl,
  onOpenSession,
  onSecondOpinion,
  onHandoff,
  onMovePane,
  onNewTerminal,
  onTerminalMetaChange,
}: Props) {
  // The tab record and the editors' state come off the stores, so App's
  // render passes nothing that changes with a keystroke or a save.
  const tab = useWorkspaceTabs((s) => s.tabs.find((entry) => entry.id === tabId)) ?? NO_TAB;
  const { layout } = tab;
  const editorPanes = tabSurfacePanes(tab);
  // A hidden tree reads stable empties, so a save or a lint result re-renders
  // the visible tree only; the flip to visible re-renders it with live values.
  // Navigation stays live: a request can land in the commit that shows the tab.
  const dirtyFileIds = useEditors((s) => (visible ? s.dirtyFiles : NO_DIRTY));
  const fileErrorCounts = useEditors((s) => (visible ? s.fileErrorCounts : NO_COUNTS));
  const editorNavigation = useEditors((s) => s.navigation);
  const recents = useProject((s) => (visible ? s.recents : NO_RECENTS));
  const hideProjectPicker = useSidebarLayout() === "deck";
  // Focus: the shown tab's focused pane, unless the diff or the dock holds
  // it; the composer only once the deferred pass has caught up with the click.
  const settled = useWorkspaceTabs((s) => visible && s.activeTabId === tabId);
  const dockFocused = useFocus((s) => visible && s.projectTerminalFocused);
  const composerWanted = useFocus((s) => visible && s.composerFocused);
  const focusedId = visible && !tab.diffFocused && !dockFocused ? tab.focusedId : "";
  const composerFocused = composerWanted && !dockFocused && settled;
  const treeRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const [draft, setDraft] = useState<LayoutNode | null>(null);
  const [paneDrag, setPaneDrag] = useState<PaneDrag | null>(null);
  const externalDrop = useExternalPaneDrop(visible);
  const drop = paneDrag ?? externalDrop;
  const onMovePaneRef = useRef(onMovePane);
  onMovePaneRef.current = onMovePane;
  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;

  useEffect(() => {
    setDraft(null);
  }, [layout]);

  // A sash drag re-renders this tree every frame. `SessionPane` compares props
  // shallowly, so handing it a fresh drag handler each frame would re-render
  // the whole session subtree (transcript, composer, picker) per frame.
  const dragHandlers = useRef(
    new Map<string, (event: ReactPointerEvent<HTMLElement>) => void>(),
  );
  const paneDragStartFor = (paneId: string) => {
    const cached = dragHandlers.current.get(paneId);
    if (cached) return cached;
    const handler = (event: ReactPointerEvent<HTMLElement>) =>
      startPaneDrag(paneId, event);
    dragHandlers.current.set(paneId, handler);
    return handler;
  };

  const tree = draft ?? layout;
  const leaves = layoutLeaves(tree);
  const sashes = layoutSashes(tree);
  const inSplit = leaves.length > 1;

  const startPaneDrag = useCallback(
    (fromId: string, event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      const handle = event.currentTarget;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startY = event.clientY;
      let active = false;

      let lastX = startX;
      let lastY = startY;
      handle.setPointerCapture(pointerId);
      const restoreSelection = suppressTextSelection();

      const onMove = (ev: PointerEvent) => {
        lastX = ev.clientX;
        lastY = ev.clientY;
        if (!active) {
          if (
            Math.hypot(ev.clientX - startX, ev.clientY - startY) <
            DRAG_THRESHOLD
          ) {
            return;
          }
          active = true;
          setGrabbing(true);
          onFocusRef.current(fromId);
          setPaneDrag({ fromId, overId: null, edge: "left" });
        }
        const over = paneDropFromPoint(ev.clientX, ev.clientY);
        if (!over || over.id === fromId) {
          setPaneDrag({
            fromId,
            overId: over?.id === fromId ? fromId : null,
            edge: over?.edge ?? "left",
          });
          return;
        }
        setPaneDrag({ fromId, overId: over.id, edge: over.edge });
      };

      const onUp = () => finish(true);
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key !== "Escape") return;
        ev.preventDefault();
        finish(false);
      };

      function finish(commit: boolean) {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        window.removeEventListener("keydown", onKey);
        restoreSelection();
        setGrabbing(false);
        setPaneDrag(null);
        try {
          handle.releasePointerCapture(pointerId);
        } catch {
          /* already released */
        }
        if (!active || !commit) return;
        const over = paneDropFromPoint(lastX, lastY);
        if (over && over.id !== fromId) {
          onMovePaneRef.current(fromId, over.id, over.edge);
        }
      }

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      window.addEventListener("keydown", onKey);
    },
    [],
  );

  return (
    <PaneVisibilityContext.Provider value={visible}>
    <div ref={treeRef} className="relative h-full min-h-0 min-w-0">
      {leaves.map((leaf) => {
        const editorPane = editorPanes.find((pane) => pane.id === leaf.id);
        const dragging = drop?.fromId === leaf.id;
        const onPaneDragStart = inSplit ? paneDragStartFor(leaf.id) : undefined;
        return (
          <div
            key={leaf.id}
            data-pane-id={leaf.id}
            className={`absolute flex min-h-0 min-w-0 flex-col overflow-hidden ${dragging ? "opacity-40" : ""}`}
            style={{
              left: `${leaf.rect.x * 100}%`,
              top: `${leaf.rect.y * 100}%`,
              width: `${leaf.rect.w * 100}%`,
              height: `${leaf.rect.h * 100}%`,
            }}
          >
            {drop && drop.overId === leaf.id && drop.fromId !== leaf.id ? (
              <PaneDropHint edge={drop.edge} />
            ) : null}
            {editorPane ? (
              <FilePane
                pane={editorPane}
                focused={focusedId === editorPane.id}
                dirtyFileIds={dirtyFileIds}
                fileErrorCounts={fileErrorCounts}
                onFocus={onFocus}
                onSelectFile={onSelectFile}
                onCloseFile={onCloseFile}
                onReorderFiles={onReorderFiles}
                onDirtyChange={onFileDirtyChange}
                onErrorCountChange={onFileErrorCountChange}
                onOpenFile={onOpenFile}
                editorNavigation={editorNavigation}
                onPaneDragStart={onPaneDragStart}
                onTerminalMetaChange={onTerminalMetaChange}
              />
            ) : (
              <SessionLeaf
                id={leaf.id}
                visible={visible}
                focused={focusedId === leaf.id}
                inSplit={inSplit}
                composerFocused={composerFocused}
                recents={recents}
                hideProjectPicker={hideProjectPicker}
                onFocus={onFocus}
                onClose={onClose}
                onCwdChange={onCwdChange}
                onBranchChange={onBranchChange}
                onModelChange={onModelChange}
                onModelSettingsChange={onModelSettingsChange}
                onRuntimeModeChange={onRuntimeModeChange}
                onThreadTypeChange={onThreadTypeChange}
                onSubmit={onSubmit}
                onStop={onStop}
                onInboxCardDismiss={onInboxCardDismiss}
                onNoteCardDismiss={onNoteCardDismiss}
                onHandoffCardDismiss={onHandoffCardDismiss}
                onApproval={onApproval}
                onOpenFile={onOpenFile}
                onOpenDiff={onOpenDiff}
                onShowSourceControl={onShowSourceControl}
                onOpenSession={onOpenSession}
                onSecondOpinion={onSecondOpinion}
                onHandoff={onHandoff}
                onNewTerminal={onNewTerminal}
                onPaneDragStart={onPaneDragStart}
              />
            )}
          </div>
        );
      })}
      {sashes.map((sash) => (
        <Sash
          key={`${sash.splitId}:${sash.index}`}
          sash={sash}
          containerRef={treeRef}
          onPreview={(ratio) =>
            setDraft(
              setSplitRatio(layoutRef.current, sash.splitId, sash.index, ratio),
            )
          }
          onCommit={(ratio) => {
            setDraft(null);
            onRatio(tabId, sash.splitId, sash.index, ratio);
          }}
          onCancel={() => setDraft(null)}
        />
      ))}
    </div>
    </PaneVisibilityContext.Provider>
  );
}

export const PaneTree = memo(PaneTreeComponent, paneTreePropsEqual);

function PaneDropHint({ edge }: { edge: PaneEdge }) {
  const wash =
    edge === "left"
      ? "absolute inset-y-0 left-0 w-1/2 bg-accent/15"
      : edge === "right"
        ? "absolute inset-y-0 right-0 w-1/2 bg-accent/15"
        : edge === "top"
          ? "absolute inset-x-0 top-0 h-1/2 bg-accent/15"
          : "absolute inset-x-0 bottom-0 h-1/2 bg-accent/15";
  const line =
    edge === "left"
      ? "absolute inset-y-0 left-0 w-0.5 bg-accent"
      : edge === "right"
        ? "absolute inset-y-0 right-0 w-0.5 bg-accent"
        : edge === "top"
          ? "absolute inset-x-0 top-0 h-0.5 bg-accent"
          : "absolute inset-x-0 bottom-0 h-0.5 bg-accent";
  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      <div className={wash} />
      <div className={line} />
    </div>
  );
}

function Sash({
  sash,
  containerRef,
  onPreview,
  onCommit,
  onCancel,
}: {
  sash: LayoutSash;
  containerRef: { current: HTMLDivElement | null };
  onPreview: (ratio: number) => void;
  onCommit: (ratio: number) => void;
  onCancel: () => void;
}) {
  const row = sash.dir === "right";
  const boundary = sash.sizes
    .slice(0, sash.index + 1)
    .reduce((sum, size) => sum + size, 0);
  const group = sash.group;

  return (
    <div
      role="separator"
      aria-orientation={row ? "vertical" : "horizontal"}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(boundary * 100)}
      className={
        row
          ? "absolute z-10 w-px bg-content/10"
          : "absolute z-10 h-px bg-content/10"
      }
      style={
        row
          ? {
              left: `${(group.x + boundary * group.w) * 100}%`,
              top: `${group.y * 100}%`,
              height: `${group.h * 100}%`,
            }
          : {
              left: `${group.x * 100}%`,
              top: `${(group.y + boundary * group.h) * 100}%`,
              width: `${group.w * 100}%`,
            }
      }
    >
      <div
        className={
          row
            ? "absolute inset-y-0 -left-1.5 -right-1.5 cursor-col-resize touch-none"
            : "absolute inset-x-0 -top-1.5 -bottom-1.5 cursor-row-resize touch-none"
        }
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const handle = e.currentTarget;
          const parent = containerRef.current;
          if (!parent) return;
          handle.setPointerCapture(e.pointerId);
          const rect = parent.getBoundingClientRect();
          const restoreSelection = suppressTextSelection();
          const previousCursor = document.body.style.cursor;
          document.body.style.cursor = row ? "col-resize" : "row-resize";
          const origin = row
            ? rect.left + group.x * rect.width
            : rect.top + group.y * rect.height;
          const span = row ? group.w * rect.width : group.h * rect.height;
          let nextBoundary = boundary;
          let moved = false;
          let frame: number | null = null;

          const move = (ev: PointerEvent) => {
            const pos = row ? ev.clientX : ev.clientY;
            if (span <= 0) return;
            moved = true;
            nextBoundary = (pos - origin) / span;
            if (frame != null) return;
            frame = requestAnimationFrame(() => {
              frame = null;
              onPreview(nextBoundary);
            });
          };
          const finish = (commit: boolean) => {
            if (frame != null) {
              cancelAnimationFrame(frame);
              frame = null;
            }
            if (handle.hasPointerCapture(e.pointerId)) {
              handle.releasePointerCapture(e.pointerId);
            }
            handle.removeEventListener("pointermove", move);
            handle.removeEventListener("pointerup", up);
            handle.removeEventListener("pointercancel", cancel);
            window.removeEventListener("keydown", keydown);
            restoreSelection();
            document.body.style.cursor = previousCursor;
            if (!moved) return;
            if (commit) onCommit(nextBoundary);
            else onCancel();
          };
          const up = () => finish(true);
          const cancel = () => finish(false);
          const keydown = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            finish(false);
          };
          handle.addEventListener("pointermove", move);
          handle.addEventListener("pointerup", up);
          handle.addEventListener("pointercancel", cancel);
          window.addEventListener("keydown", keydown);
        }}
      />
    </div>
  );
}
