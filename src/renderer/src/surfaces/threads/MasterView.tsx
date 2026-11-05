import { measureElement, useVirtualizer, type Virtualizer, type VirtualizerOptions } from "@tanstack/react-virtual";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type RefObject } from "react";
import { ConfirmDialog } from "../../chrome/ConfirmDialog";
import { RowsContextMenu, RowsMenu } from "../../chrome/menuRows";
import { useThreadMenu } from "../../chrome/useThreadMenu";
import { MoreHorizontal, Plus } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import { registry } from "../../lib/connection";
import { useEnvironments, useEnvironmentStatuses } from "../../lib/connection/status";
import * as commands from "../../lib/tcserver/commands";
import type { SessionMeta } from "../../lib/tcserver/types";
import { resourcesHeldBy } from "../../lib/threadBatch";
import { actionFailed } from "../../lib/threadActionToast";
import { useProjects, useWorkspaces } from "../../lib/tcserver/workspaces";
import { useMetaById } from "../../lib/threads/agents";
import { rightPanel } from "../../lib/rightPanel";
import { sessionStore, useSessionMetasWhen } from "../../lib/tcserver/store";
import { chatOf, heldRowOf } from "./chatSlots";
import { ArchiveBatchDialog } from "./master/ArchiveBatchDialog";
import { BatchAddDialog } from "./master/BatchAddDialogs";
import { BatchFoot } from "./master/BatchFoot";
import { addMenuItems, adoptCandidates, boardMenuItems, doneRows, pairedProjectIds, pausableRows, pausedRows, type ArchiveWhich } from "./master/boardActions";
import { ChildPane } from "./master/ChildPane";
import { MasterRow, type RowMenu } from "./master/MasterRow";
import { RowBoundary } from "./master/RowBoundary";
import { taskProgress } from "./master/rowBody";
import { taskFoldChoice, taskFoldKey, taskFoldOpen } from "./master/taskFold";
import { NewPassDialog } from "./master/NewPassDialog";
import { AgentSummaryContext } from "./master/agentSummary";
import {
  archiveBatch,
  BoardDigestContext,
  doneTally,
  groupOf,
  rowHost,
  rowModels,
  setBatchRules,
  stopBatchStep,
  useBatchState,
  useMasterModel,
  type BatchHolder,
  type BoardGroup,
  type BoardRowRef,
  type RowHost,
} from "./master/useMasterModel";
import { SplitShell, useSplit } from "./SplitShell";
import type { ThreadViewProps } from "./ThreadView";
import { useChatFold } from "../../lib/chatFold";
import { ChunkBoundary } from "../../lib/lazyChunk";
import { tagRendererError } from "../../lib/rendererErrors";
import { COLUMN_MAX_CLASS } from "../transcriptOutlineModel";
import { blockedReason } from "@shared/batchWords";

/**
 * A master thread (CLAUDE.md "Master threads", docs/LAYOUT.md "Master"):
 * the batch board on the left, the master's own chat on the right on the
 * SplitShell recipe, the chat folding from the header toggle as elsewhere. The
 * rows are the batch's children on every host the renderer knows, each
 * with its host's dot and name when it is not the master's, under the
 * offline tint while that host is out of reach; every action reaches the
 * row's own host. A row opens its thread's full view in the whole pane
 * with one Back control (Escape and ⌘↩ too); the board comes back at the
 * scroll it was left at. A right-click on a row, or on a subagent line
 * under it, opens that thread's menu (lib/threadMenu.ts): New pass… first,
 * a dialog with the thread's own composer (NewPassDialog), then Open and
 * the thread's rows as every surface has them (chrome/useThreadMenu.tsx).
 * The board comes with the batch (`boardShown`): while the batch has a row
 * or a step runs. Until then, and again once the batch empties, the master
 * is its transcript alone, as any thread; its thread menu holds New batch
 * thread… and Add existing thread… meanwhile. A board that arrives live
 * opens the chat and fades in (SplitShell); one that leaves goes at once.
 *
 * The board paints from one `batch.board` answer (useMasterModel) and
 * mounts only the rows on screen: the list is virtualized with the
 * sections as their own header rows, each row memoized on its own data.
 * Its first complete paint is reported once per open as
 * `board-paint master=<id> n=<rows> ms=<since mount>` (stall.report).
 *
 * The master's own subagents (spawn_agent, not its batch) sit where every
 * thread's do: the right panel's Agents section and the pulse line above
 * the composer. They are never board rows.
 */

/** The children Pause all would reach: a running turn anywhere in their
 *  tree, by the fleet switches' rule (lib/threadBatch.ts). */
export function pausable(children: readonly SessionMeta[]): SessionMeta[] {
  return pausableRows(children.map((meta) => ({ meta }))).map((r) => r.meta);
}


type BoardItem = { kind: "header"; key: string; group: BoardGroup } | { kind: "row"; key: string; row: BoardRowRef };

/** One board row in its boundary, memoized on its own data: a board render
 *  (a row joining, a menu opening) leaves an unchanged row, its boundary
 *  and its chunk attempt alone. */
const BoardRow = memo(function BoardRow({
  masterId,
  ...row
}: { masterId: string } & Omit<ComponentProps<typeof MasterRow>, "masterId">) {
  return (
    <RowBoundary threadId={masterId} rowId={row.rowRef.id}>
      <MasterRow masterId={masterId} {...row} />
    </RowBoundary>
  );
});

/** The foot on the batch's whole state: the one part of the view a step's log line renders. */
const LiveBatchFoot = memo(function LiveBatchFoot({ holder, ...foot }: { holder: BatchHolder } & Omit<ComponentProps<typeof BatchFoot>, "batch">) {
  return <BatchFoot batch={useBatchState(holder)} {...foot} />;
});

/** A section heading is 32px, its words on the last 16px with 4px under
 *  them; the first one 24px. A row is 48px (MasterRow), 64px with its task
 *  bar's line, and 20px a task more with its list open (the compact
 *  TaskRows, 2px above and under); rows sit flush. */
const HEADER_PX = 32;
const FIRST_HEADER_PX = 24;
const ROW_PX = 48;
const BAR_LINE_PX = 16;
const TASK_ROW_PX = 20;
const TASK_FOLD_PAD_PX = 4;

/** Row sizes come from the ResizeObserver (WorkspaceSessions' rule): a row
 *  mounting while the list scrolls keeps its cached or estimated size
 *  instead of reading a rect, which would force a layout per new row. */
const measureRow: VirtualizerOptions<HTMLDivElement, HTMLDivElement>["measureElement"] = (node, entry, instance) => {
  if (entry) return measureElement(node, entry, instance);
  const index = instance.indexFromElement(node);
  return instance.measurementsCache[index]?.size ?? instance.options.estimateSize(index);
};

/**
 * The board's rows, virtualized, with the scroller they scroll in. The
 * virtualizer re-renders the component that holds it, through flushSync,
 * whenever its range or its `isScrolling` moves (as a scroll starts and
 * rests, and at every row a long board's window gains or drops): held here,
 * that re-renders this list and its section headers, the rows staying as
 * they are (BoardRow), never the board, its header, foot and chat.
 */
const BoardList = memo(function BoardList({
  items,
  scroller,
  savedScroll,
  estimateSize,
  api,
  masterId,
  landed,
  blockedOf,
  hostOf,
  onOpen,
  menu,
}: {
  items: BoardItem[];
  /** The board's scroller, drawn here, so the virtualizer finds it attached in its first layout effect. */
  scroller: RefObject<HTMLDivElement | null>;
  savedScroll: RefObject<number>;
  estimateSize: (index: number) => number;
  /** The virtualizer, for the board's return from a child (MasterBoardView). */
  api: RefObject<Virtualizer<HTMLDivElement, HTMLDivElement> | null>;
  masterId: string;
  landed: ReadonlySet<string>;
  blockedOf: (row: BoardRowRef) => string | null;
  hostOf: (environmentId: string) => RowHost | null;
  onOpen: (id: string, focus?: boolean) => void;
  menu: RowMenu;
}) {
  const getItemKey = useCallback((i: number) => items[i]?.key ?? i, [items]);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller.current,
    estimateSize,
    getItemKey,
    overscan: 6,
    gap: 0,
    initialOffset: () => savedScroll.current,
    measureElement: measureRow,
  });
  useLayoutEffect(() => {
    api.current = virtualizer;
    return () => {
      api.current = null;
    };
  }, [api, virtualizer]);
  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-1 pt-1 pb-2" data-board-scroller>
      <RowsContextMenu
        label="Thread actions"
        lazyMount
        rowsFor={(id) => (id ? menu.rowsFor(id) : null)}
        onPick={(pick, id) => id && menu.onPick(id, pick)}
        onOpenChange={(open, id) => id && menu.onOpenChange(id, open)}
      >
    {/* The board pane: every task bar is 35% of it (TASK_BAR_CLASS). */}
    <div className="@container relative w-full" style={{ height: virtualizer.getTotalSize() }} data-board-pane>
      {virtualizer.getVirtualItems().map((v) => {
        const item = items[v.index];
        if (!item) return null;
        return (
          <div
            key={v.key}
            data-index={v.index}
            data-group={item.kind === "row" ? item.row.group : undefined}
            ref={virtualizer.measureElement}
            className="absolute top-0 left-0 w-full"
            style={{ transform: `translateY(${v.start}px)` }}
          >
            {item.kind === "header" ? (
              <h3
                className={`flex ${v.index === 0 ? "h-6" : "h-8"} items-end px-2 pb-1 text-xs leading-4 font-medium text-muted-foreground`}
                data-group-header={item.group.id}
              >
                {item.group.label}
              </h3>
            ) : (
              <BoardRow masterId={masterId} rowRef={item.row} landed={landed.has(item.row.id)} blocked={blockedOf(item.row)} host={hostOf(item.row.environmentId)} onOpen={onOpen} menu={menu} />
            )}
          </div>
        );
      })}
    </div>
      </RowsContextMenu>
    </div>
  );
});

/** The board's first complete paint, once per open, to this machine's stall log. */
function reportBoardPaint(masterId: string, rows: number, ms: number): void {
  try {
    void registry
      .primary()
      .request("stall.report", { line: `board-paint master=${masterId} n=${rows} ms=${Math.round(ms)}` })
      .catch(() => undefined);
  } catch {
    // No local link yet (web mode before connect): the report is a nicety.
  }
}

/**
 * The board in its own boundary: a board that throws (its model, a row
 * outside its RowBoundary, the foot) leaves the master as its transcript
 * alone under one line with Retry, so the chat, its composer and the rail
 * stay usable; the error's stalls.log line ends `thread=<id> view=master`.
 * Retry mounts the board afresh.
 */
export function MasterView(props: ThreadViewProps) {
  const id = props.session.id;
  return (
    <ChunkBoundary
      name={`master-board.${id}`}
      fallback={null}
      onRetry={() => {}}
      onError={(error) => tagRendererError(error, { thread: id, view: "master" })}
      failed={(retry) => <BoardFailed renderChat={props.renderChat} onRetry={retry} />}
    >
      <MasterBoardView {...props} />
    </ChunkBoundary>
  );
}

/** The master as ChatView draws a thread, under the load line's grid: the line, then Retry. */
export function BoardFailed({ renderChat, onRetry }: Pick<ThreadViewProps, "renderChat"> & { onRetry: () => void }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col [contain:layout_style]" data-board-failed>
      <div role="alert" className={`mx-auto mt-2 flex h-6 w-full ${COLUMN_MAX_CLASS} shrink-0 items-center gap-2 px-4 text-xs text-muted-foreground`}>
        <span className="min-w-0 flex-1 truncate">Couldn't load the board</span>
        <Button variant="ghost" size="xs" className="shrink-0" onClick={onRetry}>
          Retry
        </Button>
      </div>
      {renderChat()}
    </div>
  );
}

function MasterBoardView(props: ThreadViewProps) {
  const { session } = props;
  const meta = useMetaById(session.id);
  const model = useMasterModel(session);
  const { layout, batch, view, showBoard, digests, summaries, loaded, landed, openId, setOpenId } = model;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const openMeta = useMetaById(openId);
  const environments = useEnvironments();
  const statuses = useEnvironmentStatuses();
  const hostNames = useMemo(() => new Map(environments.map((e) => [e.id, e.name])), [environments]);
  // One host object per host, so a row's props stay the same while its host does.
  const masterHost = session.environmentId;
  const hostOf = useMemo(() => {
    const cache = new Map<string, RowHost | null>();
    return (environmentId: string): RowHost | null => {
      if (!cache.has(environmentId)) cache.set(environmentId, rowHost({ environmentId }, { environmentId: masterHost }, environments, (id) => statuses.get(id)));
      return cache.get(environmentId) ?? null;
    };
  }, [environments, statuses, masterHost]);
  const [chatOpen, setChatOpen] = useChatFold(session.id, true, session.status === "waiting");
  // A board that arrives live (the first child, or a step starting after
  // the batch emptied) comes with the chat open: a fold remembered from an
  // earlier batch never pulls the person off the transcript they read. A
  // board already there at the first render keeps its remembered fold.
  const [sawBoard, setSawBoard] = useState(showBoard);
  if (showBoard !== sawBoard) {
    setSawBoard(showBoard);
    if (showBoard && !chatOpen) setChatOpen(true);
  }
  // The open title-bar menu: the rows' metas are read only while one is.
  const [menu, setMenu] = useState<"board" | "add" | null>(null);
  const [adding, setAdding] = useState<"new" | "adopt" | null>(null);
  const [archiving, setArchiving] = useState<ArchiveWhich | null>(null);
  const [pausing, setPausing] = useState(false);
  const [focusComposer, setFocusComposer] = useState(false);
  const [passFor, setPassFor] = useState<string | null>(null);
  const threadMenu = useThreadMenu({
    onOpen: (id) => openRef.current(id),
    onNewPass: setPassFor,
    // A row the board's answer names before the store holds it menus from that answer.
    metaFor: (id) => layoutRef.current.rows.find((r) => r.id === id)?.fallback ?? null,
  });
  // The rows' ⋯ and the board's one right-click read the same list, with Open and New pass….
  const menuApi = useRef(threadMenu);
  menuApi.current = threadMenu;
  const rowMenu = useMemo<RowMenu>(
    () => ({
      rowsFor: (id) => menuApi.current.rowsFor(id, { open: true, newPass: true }),
      onPick: (id, pick) => menuApi.current.onPick(id, pick),
      onOpenChange: (id, open) => menuApi.current.onOpenChange(id, open),
    }),
    [],
  );
  // The rows' metas (and the adopt candidates' count) are read, and
  // followed, only while a menu or a dialog needs them; never per frame of
  // the board. The add dialogs read their own (BatchAddDialog).
  const reading = menu !== null || archiving !== null || pausing;
  const metas = useSessionMetasWhen(reading);
  const rows = useMemo(() => (reading ? rowModels(layout) : []), [reading, layout, metas]);
  const toPause = pausableRows(rows);
  const paused = pausedRows(rows);
  // The host's own rule, so the count and what leaves agree.
  const done = doneRows(rows, view);
  const workspaces = useWorkspaces();
  const projects = useProjects();
  const paired = useMemo(() => (meta ? pairedProjectIds(meta, workspaces, projects) : new Set<string>()), [meta, workspaces, projects]);
  const candidates = useMemo(() => (meta && menu === "add" ? adoptCandidates(metas, meta, paired) : []), [metas, meta, paired, menu]);

  // A trip into a child's full view comes back where it left: the split the
  // person set, the board's scroll, and the focus on the row that opened it.
  const split = useSplit(50);
  const scroller = useRef<HTMLDivElement>(null);
  const savedScroll = useRef(0);
  const returnTo = useRef<string | null>(null);

  const items = useMemo<BoardItem[]>(
    () =>
      layout.groups.flatMap((group): BoardItem[] => [
        { kind: "header", key: `h:${group.id}`, group },
        ...group.rows.map((row): BoardItem => ({ kind: "row", key: `r:${row.key}`, row })),
      ]),
    [layout],
  );
  // A row with its task bar is a line taller, and its open list a row a
  // task (open while the thread is live, MasterRow); the measure follows the fold.
  const estimateSize = useCallback(
    (i: number) => {
      const item = items[i];
      if (item?.kind !== "row") return i === 0 ? FIRST_HEADER_PX : HEADER_PX;
      const meta = sessionStore.metaOf(item.row.id) ?? item.row.fallback;
      const progress = meta ? taskProgress(meta, digests.get(item.row.id)) : null;
      if (!meta || !progress) return ROW_PX;
      const key = taskFoldKey(session.id, item.row.key);
      const live = groupOf(meta) !== "done";
      if (!live && taskFoldChoice(key) !== true) return ROW_PX;
      return ROW_PX + BAR_LINE_PX + (taskFoldOpen(key, live) ? progress.total * TASK_ROW_PX + TASK_FOLD_PAD_PX : 0);
    },
    [items, digests, session.id],
  );
  const list = useRef<Virtualizer<HTMLDivElement, HTMLDivElement> | null>(null);

  // Back from a child: the saved offset first, then the row that opened it in
  // view and focused. Rows re-sort by state while a child is open, so the raw
  // offset can land elsewhere; a row the board no longer lists leaves the offset.
  // BoardList draws the scroller and attaches its virtualizer in its own
  // layout effects, which run before this one.
  useLayoutEffect(() => {
    if (openId) return;
    const el = scroller.current;
    const id = returnTo.current;
    returnTo.current = null;
    if (!el) return;
    el.scrollTop = savedScroll.current;
    if (!id) return;
    const index = items.findIndex((item) => item.kind === "row" && item.row.id === id);
    if (index < 0) return;
    const rowOf = () => el.querySelector<HTMLElement>(`[data-menu-id="${id}"]`);
    const land = (row: HTMLElement) => {
      row.scrollIntoView?.({ block: "nearest" });
      row.focus({ preventScroll: true });
    };
    const row = rowOf();
    if (row) return land(row);
    // Out of the rendered window: bring it in, and focus it once it is drawn.
    list.current?.scrollToIndex(index, { align: "auto" });
    const frame = requestAnimationFrame(() => {
      const drawn = rowOf();
      if (drawn) land(drawn);
    });
    return () => cancelAnimationFrame(frame);
    // Only a return from a child decides this; the rows and the virtualizer are read as they stand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId]);

  // The first complete paint: the answer is in and its rows are on screen.
  const openedAt = useRef(performance.now());
  const painted = useRef(false);
  const paintFrame = useRef<number | null>(null);
  useEffect(() => {
    if (painted.current || !loaded || openId || !showBoard) return;
    painted.current = true;
    const n = layout.rows.length;
    paintFrame.current = requestAnimationFrame(() => reportBoardPaint(session.id, n, performance.now() - openedAt.current));
  }, [loaded, openId, showBoard, layout, session.id]);
  // A board that leaves before its frame paints reports nothing: the line is
  // about a paint the person saw.
  useEffect(
    () => () => {
      if (paintFrame.current !== null) cancelAnimationFrame(paintFrame.current);
    },
    [],
  );

  // The child that blocks the batch's end says why on its own row (a far
  // child is named `<env>:<session>`); every other row gets null.
  const blocked = view.blocked;
  const blockedOf = useCallback(
    (row: BoardRowRef): string | null => {
      if (!blocked || (blocked.sessionId !== row.id && blocked.sessionId !== `${row.environmentId}:${row.id}`)) return null;
      return blockedReason(blocked.why, blocked.environmentId ? hostNames.get(blocked.environmentId) : null);
    },
    [blocked, hostNames],
  );

  const openRef = useRef<(id: string, focus?: boolean) => void>(() => {});
  openRef.current = (id: string, focus = false) => {
    savedScroll.current = scroller.current?.scrollTop ?? 0;
    returnTo.current = id;
    setFocusComposer(focus);
    setOpenId(id);
  };
  const open = useCallback((id: string, focus?: boolean) => openRef.current(id, focus), []);

  // The pane's right panel and agents cue follow the thread the pane shows:
  // the open child or subagent, on its own host; Back hands them back.
  const shownHost = openId ? (layout.rows.find((r) => r.id === openId)?.environmentId ?? openMeta?.environmentId) : undefined;
  useEffect(() => {
    rightPanel.showThread(session.id, openId && shownHost ? { id: openId, environmentId: shownHost } : null);
  }, [openId, session.id, shownHost]);
  useEffect(() => () => rightPanel.showThread(session.id, null), [session.id]);

  // Pause all and Resume all, one session.batch per host; what a host
  // refused (or never got) is said in one toast, never dropped.
  const byHost = async (list: readonly { meta: SessionMeta }[], action: "pause" | "resume") => {
    const map = new Map<string, string[]>();
    for (const { meta: c } of list) (map.get(c.environmentId) ?? map.set(c.environmentId, []).get(c.environmentId)!).push(c.id);
    const hosts = [...map];
    const results = await Promise.allSettled(hosts.map(([env, ids]) => commands.sessionBatch(env, action, ids)));
    const failed: { id: string; error: unknown }[] = [];
    results.forEach((r, i) => {
      if (r.status === "rejected") for (const id of hosts[i][1]) failed.push({ id, error: r.reason });
      else for (const f of r.value?.failed ?? []) failed.push({ id: f.sessionId, error: f.error });
    });
    if (failed.length === 0) return;
    const titleOf = (id: string) => list.find(({ meta: c }) => c.id === id)?.meta.title || "Untitled";
    if (failed.length === 1) actionFailed(`${action} it`, titleOf(failed[0].id), failed[0].error);
    else actionFailed(`${action} ${failed.length} threads`, session.title || "The batch", failed[0].error);
  };

  const onMenuPick = (id: string) => {
    setMenu(null);
    if (id === "pause") setPausing(true);
    else if (id === "resume") void byHost(paused, "resume");
    else if (id === "archive-done") setArchiving("done");
    else if (id === "archive-all") setArchiving("all");
    else if (id === "new" || id === "adopt") setAdding(id);
  };

  // The title bar's two menus, built once per change in what they offer: the
  // view renders on every batch and meta push, and fresh menus each time
  // re-rendered their triggers, tooltips and buttons with it.
  const pickRef = useRef(onMenuPick);
  useLayoutEffect(() => {
    pickRef.current = onMenuPick;
  });
  const pick = useCallback((id: string) => pickRef.current(id), []);
  const pausableCount = toPause.length;
  const pausedCount = paused.length;
  const doneCount = done.length;
  const rowCount = layout.rows.length;
  const candidateCount = candidates.length;
  const actions = useMemo(
    () => (
      <>
        <RowsMenu
          label="Batch actions"
          tip={{ label: "Batch actions" }}
          trigger={
            <Button variant="ghost" size="icon-sm" aria-label="Batch actions">
              <MoreHorizontal />
            </Button>
          }
          rows={() => boardMenuItems({ pausable: pausableCount, paused: pausedCount, done: doneCount, all: rowCount })}
          onPick={pick}
          onOpenChange={(open) => setMenu(open ? "board" : null)}
        />
        <RowsMenu
          label="Add thread"
          tip={{ label: "Add thread" }}
          trigger={
            <Button variant="ghost" size="icon-sm" aria-label="Add thread">
              <Plus />
            </Button>
          }
          rows={() => addMenuItems(candidateCount)}
          onPick={pick}
          onOpenChange={(open) => setMenu(open ? "add" : null)}
        />
      </>
    ),
    [candidateCount, doneCount, pausableCount, pausedCount, pick, rowCount],
  );

  // The foot's callbacks, stable across board renders: it re-renders for the batch alone.
  const titleOf = useCallback((id: string) => rowModels(layoutRef.current).find((r) => r.meta.id === id)?.title, []);
  const hostName = useCallback((id: string) => hostNames.get(id), [hostNames]);
  const masterEnv = session.environmentId;
  const masterId = session.id;
  const saveRules = useCallback((next: Parameters<typeof setBatchRules>[2]) => setBatchRules(masterEnv, masterId, next), [masterEnv, masterId]);
  const stopStep = useCallback((stepId: string) => stopBatchStep(masterEnv, masterId, stepId), [masterEnv, masterId]);
  // The chat's slots only when the pane hands new render functions: a board push renders no chat column, footer, transcript or composer.
  const { renderSlots, renderChat } = props;
  const chat = useMemo(() => chatOf({ renderSlots, renderChat }), [renderSlots, renderChat]);

  // A row, or a subagent opened from a row's agent lines (it lives on its own host).
  const openHost = shownHost;
  if (openId && openHost) {
    return (
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <ChildPane
          key={openId}
          sessionId={openId}
          environmentId={openHost}
          title={rowModels(layout).find((r) => r.meta.id === openId)?.title}
          focusComposer={focusComposer}
          onBack={() => setOpenId(null)}
          onOpenFile={props.onOpenFile}
          onOpenDiff={props.onOpenDiff}
          onOpenSession={props.onOpenSession}
        />
      </div>
    );
  }

  const title = meta?.title || session.title || "Master";
  const board = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <BoardDigestContext.Provider value={digests}>
        <AgentSummaryContext.Provider value={summaries}>
            <BoardList
              items={items}
              scroller={scroller}
              savedScroll={savedScroll}
              estimateSize={estimateSize}
              api={list}
              masterId={session.id}
              landed={landed}
              blockedOf={blockedOf}
              hostOf={hostOf}
              onOpen={open}
              menu={rowMenu}
            />
        </AgentSummaryContext.Provider>
      </BoardDigestContext.Provider>
      <LiveBatchFoot holder={batch} loaded={loaded} titleOf={titleOf} hostName={hostName} onSave={saveRules} onStop={stopStep} toastAnchor={!chatOpen} />
    </div>
  );

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <SplitShell
        board={board}
        chat={chat}
        hasBoard={showBoard}
        splitState={split}
        collapsed={!chatOpen}
        onToggleChat={setChatOpen}
        title={title}
        detail={doneTally(layout) ?? undefined}
        actions={actions}
        held={heldRowOf(props, session)}
      />
      {adding ? <BatchAddDialog masterId={session.id} kind={adding} onClose={() => setAdding(null)} /> : null}
      {archiving ? (
        <ArchiveBatchDialog
          which={archiving}
          count={archiving === "done" ? done.length : layout.rows.length}
          resources={resourcesHeldBy((archiving === "done" ? done : rows).map((r) => r.meta.id))}
          onCancel={() => setArchiving(null)}
          onConfirm={(removeResources) => archiveBatch(session, rows, archiving, removeResources, batch.get())}
        />
      ) : null}
      {threadMenu.dialogs}
      {passFor ? (
        <BoardDigestContext.Provider value={digests}>
          <NewPassDialog sessionId={passFor} landed={landed.has(passFor)} onClose={() => setPassFor(null)} />
        </BoardDigestContext.Provider>
      ) : null}
      {pausing ? (
        <ConfirmDialog
          title={`Pause ${toPause.length} running thread${toPause.length === 1 ? "" : "s"}?`}
          body="Each turn holds where it is."
          confirmLabel="Pause all"
          onCancel={() => setPausing(false)}
          onConfirm={() => byHost(toPause, "pause")}
          onDone={() => setPausing(false)}
        />
      ) : null}
    </div>
  );
}
