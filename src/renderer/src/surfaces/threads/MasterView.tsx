import { measureElement, useVirtualizer, type VirtualizerOptions } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../../chrome/ConfirmDialog";
import { ExplorerMenu } from "../../chrome/ExplorerMenu";
import { MoveThreadConfirm } from "../../chrome/ThreadHostChip";
import { ArchiveThreadDialog } from "../../chrome/ThreadResourcesDialog";
import { ChevronDown, MoreHorizontal, Plus } from "../../chrome/icons";
import { registry } from "../../lib/connection";
import { useEnvironments, useEnvironmentStatuses } from "../../lib/connection/status";
import * as commands from "../../lib/tcserver/commands";
import type { SessionMeta } from "../../lib/tcserver/types";
import { resourcesHeldBy } from "../../lib/threadBatch";
import { useProjects, useWorkspaces } from "../../lib/tcserver/workspaces";
import { useMetaById } from "../../lib/threads/agents";
import { useMasterIds } from "../../lib/masterThread";
import { sessionStore, useQueue, useSessionMetasWhen } from "../../lib/tcserver/store";
import { loadThreadResources, useThreadResources } from "../../lib/threadResources";
import { moveTargets, useMoving } from "../../lib/threadMove";
import { chatOf } from "./chatSlots";
import { AddThreadDialog } from "./master/AddThreadDialog";
import { AdoptThreadDialog } from "./master/AdoptThreadDialog";
import { ArchiveBatchDialog } from "./master/ArchiveBatchDialog";
import { BatchFoot } from "./master/BatchFoot";
import { addMenuItems, adoptCandidates, boardMenuItems, doneRows, pairedProjectIds, pausableRows, pausedRows, type ArchiveWhich } from "./master/boardActions";
import { ChildPane } from "./master/ChildPane";
import { MasterRow, type OnRowMenu } from "./master/MasterRow";
import { NewPassDialog } from "./master/NewPassDialog";
import { RenameThreadDialog } from "./master/RenameThreadDialog";
import { rowMenuItems } from "./master/rowMenu";
import { AgentSummaryContext } from "./master/agentSummary";
import {
  adoptThreads,
  archiveBatch,
  BoardDigestContext,
  rowHost,
  rowModels,
  setBatchRules,
  stopBatchStep,
  useMasterModel,
  type BoardGroup,
  type BoardRowRef,
  type RowHost,
} from "./master/useMasterModel";
import { ChatToggle, SplitShell } from "./SplitShell";
import type { ThreadViewProps } from "./ThreadView";

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
 * under it, opens that thread's menu (master/rowMenu.ts): New pass… first,
 * a dialog with the thread's own composer (NewPassDialog), then Open and
 * the tab's thread actions with the host moves. Until the master has a first child the chat is
 * the whole view, the way an orchestration thread opens.
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

const QUIET_ICON =
  "pressable grid size-6 place-items-center rounded-md text-content/50 hover:bg-content/5 hover:text-content";
const BORDERED_BUTTON =
  "pressable inline-flex h-6 items-center gap-1 rounded-md border border-content/10 px-2 text-xs text-content hover:bg-content/5";

/** The children Pause all would reach: a running turn anywhere in their
 *  tree, by the fleet switches' rule (lib/threadBatch.ts). */
export function pausable(children: readonly SessionMeta[]): SessionMeta[] {
  return pausableRows(children.map((meta) => ({ meta }))).map((r) => r.meta);
}

type Menu = { kind: "board" | "add"; x: number; y: number };
type RowMenu = { id: string; x: number; y: number };

type BoardItem = { kind: "header"; key: string; group: BoardGroup } | { kind: "row"; key: string; row: BoardRowRef };

const HEADER_PX = 36;
const ROW_PX = 54;

/** Row sizes come from the ResizeObserver (WorkspaceSessions' rule): a row
 *  mounting while the list scrolls keeps its cached or estimated size
 *  instead of reading a rect, which would force a layout per new row. */
const measureRow: VirtualizerOptions<HTMLDivElement, HTMLDivElement>["measureElement"] = (node, entry, instance) => {
  if (entry) return measureElement(node, entry, instance);
  const index = instance.indexFromElement(node);
  return instance.measurementsCache[index]?.size ?? instance.options.estimateSize(index);
};

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

const menuAt = (el: HTMLElement, kind: Menu["kind"]): Menu => {
  const rect = el.getBoundingClientRect();
  return { kind, x: rect.left, y: rect.bottom + 4 };
};

export function MasterView(props: ThreadViewProps) {
  const { session } = props;
  const meta = useMetaById(session.id);
  const model = useMasterModel(session);
  const { layout, batch, digests, summaries, loaded, landed, openId, setOpenId } = model;
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
  const [chatOpen, setChatOpen] = useState(true);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [adding, setAdding] = useState(false);
  const [adopting, setAdopting] = useState(false);
  const [archiving, setArchiving] = useState<ArchiveWhich | null>(null);
  const [pausing, setPausing] = useState(false);
  const [focusComposer, setFocusComposer] = useState(false);
  const [rowMenu, setRowMenu] = useState<RowMenu | null>(null);
  const [passFor, setPassFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [moving, setMoving] = useState<{ id: string; to: string; name: string } | null>(null);
  const masterIds = useMasterIds();
  const moves = useMoving();
  const menuQueue = useQueue(rowMenu?.id ?? "");
  const archiveResources = useThreadResources(archivingId);
  const hasBoard = layout.rows.length > 0;
  // The rows' metas (and the adopt candidates) are read, and followed, only
  // while a menu or a dialog needs them; never per frame of the board.
  const reading = menu !== null || adding || archiving !== null || pausing;
  const metas = useSessionMetasWhen(reading || adopting);
  const rows = useMemo(() => (reading ? rowModels(layout) : []), [reading, layout, metas]);
  const children = useMemo(() => rows.map((r) => r.meta), [rows]);
  const toPause = pausableRows(rows);
  const paused = pausedRows(rows);
  const done = doneRows(rows);
  const workspaces = useWorkspaces();
  const projects = useProjects();
  const paired = useMemo(() => (meta ? pairedProjectIds(meta, workspaces, projects) : new Set<string>()), [meta, workspaces, projects]);
  const candidates = useMemo(() => (meta ? adoptCandidates(metas, meta, paired) : []), [metas, meta, paired]);

  // The board's scroll offset survives a trip into a child's full view.
  const scroller = useRef<HTMLDivElement>(null);
  const savedScroll = useRef(0);
  useLayoutEffect(() => {
    if (!openId && scroller.current) scroller.current.scrollTop = savedScroll.current;
  }, [openId]);

  const items = useMemo<BoardItem[]>(
    () =>
      layout.groups.flatMap((group): BoardItem[] => [
        { kind: "header", key: `h:${group.id}`, group },
        ...group.rows.map((row): BoardItem => ({ kind: "row", key: `r:${row.key}`, row })),
      ]),
    [layout],
  );
  const estimateSize = useCallback((i: number) => (items[i]?.kind === "header" ? HEADER_PX : ROW_PX), [items]);
  const getItemKey = useCallback((i: number) => items[i]?.key ?? i, [items]);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller.current,
    estimateSize,
    getItemKey,
    overscan: 6,
    gap: 1,
    initialOffset: () => savedScroll.current,
    measureElement: measureRow,
  });

  // The first complete paint: the answer is in and its rows are on screen.
  const openedAt = useRef(performance.now());
  const painted = useRef(false);
  const paintFrame = useRef<number | null>(null);
  useEffect(() => {
    if (painted.current || !loaded || openId || !hasBoard) return;
    painted.current = true;
    const n = layout.rows.length;
    paintFrame.current = requestAnimationFrame(() => reportBoardPaint(session.id, n, performance.now() - openedAt.current));
  }, [loaded, openId, hasBoard, layout, session.id]);
  // A board that leaves before its frame paints reports nothing: the line is
  // about a paint the person saw.
  useEffect(
    () => () => {
      if (paintFrame.current !== null) cancelAnimationFrame(paintFrame.current);
    },
    [],
  );

  const openRef = useRef<(id: string, focus?: boolean) => void>(() => {});
  openRef.current = (id: string, focus = false) => {
    savedScroll.current = scroller.current?.scrollTop ?? 0;
    setFocusComposer(focus);
    setOpenId(id);
  };
  const open = useCallback((id: string, focus?: boolean) => openRef.current(id, focus), []);
  const onRowMenu = useCallback<OnRowMenu>((id, at) => setRowMenu({ id, ...at }), []);

  if (!hasBoard) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col [contain:layout_style]">{chatOf(props)}</div>
    );
  }

  const byHost = (list: readonly { meta: SessionMeta }[], action: "pause" | "resume") => {
    const map = new Map<string, string[]>();
    for (const { meta: c } of list) (map.get(c.environmentId) ?? map.set(c.environmentId, []).get(c.environmentId)!).push(c.id);
    return Promise.allSettled([...map].map(([env, ids]) => commands.sessionBatch(env, action, ids)));
  };

  const onMenuPick = (id: string) => {
    setMenu(null);
    if (id === "pause") setPausing(true);
    else if (id === "resume") void byHost(paused, "resume");
    else if (id === "archive-done") setArchiving("done");
    else if (id === "archive-all") setArchiving("all");
    else if (id === "new") setAdding(true);
    else if (id === "adopt") setAdopting(true);
  };

  // A row, or a subagent opened from a row's agent lines (it lives on its own host).
  const openHost = openId ? (layout.rows.find((r) => r.id === openId)?.environmentId ?? openMeta?.environmentId) : undefined;
  if (openId && openHost) {
    return (
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <ChildPane
          key={openId}
          sessionId={openId}
          environmentId={openHost}
          focusComposer={focusComposer}
          onBack={() => setOpenId(null)}
          onOpenFile={props.onOpenFile}
          onOpenDiff={props.onOpenDiff}
          onOpenSession={props.onOpenSession}
        />
      </div>
    );
  }

  // A row's (or an agent line's) menu: the thread on its own host.
  const menuMeta = rowMenu ? sessionStore.metaOf(rowMenu.id) : null;
  const menuItems = menuMeta
    ? rowMenuItems(
        menuMeta,
        masterIds.has(menuMeta.id),
        moveTargets(
          {
            ...menuMeta,
            busy: sessionStore.get(menuMeta.id)?.busy,
            treeHasLiveWork: sessionStore.get(menuMeta.id)?.treeHasLiveWork,
            treeHasPaused: sessionStore.get(menuMeta.id)?.treeHasPaused,
            queued: menuQueue.length,
          },
          environments,
          (id) => statuses.get(id) ?? { transport: "offline", lastHello: null },
          moves.has(menuMeta.id),
        ),
      )
    : [];
  const onRowPick = (pick: string) => {
    const id = rowMenu?.id;
    setRowMenu(null);
    if (!id) return;
    const quiet = (run: Promise<unknown>) => void run.catch(() => undefined);
    if (pick === "new-pass") setPassFor(id);
    else if (pick === "open") open(id);
    else if (pick === "rename") setRenaming(id);
    else if (pick === "resume") quiet(commands.resume(id));
    else if (pick === "pause") quiet(commands.pause(id));
    else if (pick === "stop") quiet(commands.interrupt(id));
    else if (pick === "compact") quiet(commands.compact(id));
    else if (pick === "killBackground") quiet(commands.killBackground(id));
    else if (pick === "master") quiet(commands.setMaster(id, !masterIds.has(id)));
    else if (pick === "archive") {
      void loadThreadResources(id);
      setArchivingId(id);
    } else if (pick.startsWith("move:")) {
      const to = pick.slice("move:".length);
      setMoving({ id, to, name: hostNames.get(to) ?? to });
    }
  };
  const renamingMeta = renaming ? sessionStore.metaOf(renaming) : null;
  const archivingMeta = archivingId ? sessionStore.metaOf(archivingId) : null;

  const title = meta?.title || session.title || "Master";
  const board = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-content/10 pr-2.5 pl-3.5 whitespace-nowrap">
        <span className="min-w-0 truncate text-[13px] font-medium text-content">{title}</span>
        <span className="flex-1" />
        <button
          type="button"
          aria-label="Batch actions"
          title="Batch actions"
          aria-haspopup="menu"
          aria-expanded={menu?.kind === "board" || undefined}
          onClick={(e) => setMenu(menuAt(e.currentTarget, "board"))}
          className={QUIET_ICON}
        >
          <MoreHorizontal className="size-3.5" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={menu?.kind === "add" || undefined}
          onClick={(e) => setMenu(menuAt(e.currentTarget, "add"))}
          className={BORDERED_BUTTON}
        >
          <Plus className="size-3" strokeWidth={2} />
          Thread
          <ChevronDown className="-mr-0.5 size-3 text-content/50" strokeWidth={1.75} />
        </button>
        <span className="ml-1 flex">
          <ChatToggle open={chatOpen} onToggle={setChatOpen} />
        </span>
      </div>
      <BoardDigestContext.Provider value={digests}>
        <AgentSummaryContext.Provider value={summaries}>
          <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-2.5 pt-1 pb-3" data-board-scroller>
            <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
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
                      <h3 className="px-3 pt-4 pb-1 text-xs font-medium text-muted-foreground" data-group-header={item.group.id}>
                        {item.group.label}
                      </h3>
                    ) : (
                      <MasterRow rowRef={item.row} landed={landed.has(item.row.id)} host={hostOf(item.row.environmentId)} onOpen={open} onMenu={onRowMenu} />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </AgentSummaryContext.Provider>
      </BoardDigestContext.Provider>
      <BatchFoot
          batch={batch}
          loaded={loaded}
          titleOf={(id) => rowModels(layout).find((r) => r.meta.id === id)?.title}
          onSave={(next) => setBatchRules(session.environmentId, session.id, next)}
          onStop={(stepId) => stopBatchStep(session.environmentId, session.id, stepId)}
        />
    </div>
  );

  const chat = chatOf(props);

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <SplitShell
        board={board}
        chat={chat}
        hasBoard
        collapsed={!chatOpen}
        onToggleChat={setChatOpen}
      />
      {menu ? (
        <ExplorerMenu
          x={menu.x}
          y={menu.y}
          ariaLabel={menu.kind === "board" ? "Batch actions" : "Add a thread"}
          items={
            menu.kind === "board"
              ? boardMenuItems({ pausable: toPause.length, paused: paused.length, done: done.length, all: layout.rows.length })
              : addMenuItems(candidates.length)
          }
          onPick={onMenuPick}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {adding && meta ? <AddThreadDialog master={meta} siblings={children} onClose={() => setAdding(false)} /> : null}
      {adopting ? (
        <AdoptThreadDialog
          candidates={candidates}
          hostName={(id) => hostNames.get(id) ?? id}
          onClose={() => setAdopting(false)}
          onAdopt={(threads) => adoptThreads(session, threads)}
        />
      ) : null}
      {archiving ? (
        <ArchiveBatchDialog
          which={archiving}
          count={archiving === "done" ? done.length : layout.rows.length}
          resources={resourcesHeldBy((archiving === "done" ? done : rows).map((r) => r.meta.id))}
          onCancel={() => setArchiving(null)}
          onConfirm={(removeResources) => archiveBatch(session, rows, archiving, removeResources)}
        />
      ) : null}
      {rowMenu && menuItems.length > 0 ? (
        <ExplorerMenu x={rowMenu.x} y={rowMenu.y} ariaLabel="Thread actions" items={menuItems} onPick={onRowPick} onClose={() => setRowMenu(null)} />
      ) : null}
      {passFor ? (
        <BoardDigestContext.Provider value={digests}>
          <NewPassDialog sessionId={passFor} landed={landed.has(passFor)} onClose={() => setPassFor(null)} />
        </BoardDigestContext.Provider>
      ) : null}
      {renamingMeta ? <RenameThreadDialog sessionId={renamingMeta.id} title={renamingMeta.title} onClose={() => setRenaming(null)} /> : null}
      {archivingMeta ? (
        <ArchiveThreadDialog
          sessionId={archivingMeta.id}
          title={archivingMeta.title || "this thread"}
          resources={archiveResources}
          onCancel={() => setArchivingId(null)}
          onArchived={() => setArchivingId(null)}
        />
      ) : null}
      {moving ? (
        <MoveThreadConfirm
          sessionId={moving.id}
          to={moving.to}
          toName={moving.name}
          fromName={hostNames.get(sessionStore.metaOf(moving.id)?.environmentId ?? "") ?? "this host"}
          onClose={() => setMoving(null)}
        />
      ) : null}
      {pausing ? (
        <ConfirmDialog
          title={`Pause ${toPause.length} running thread${toPause.length === 1 ? "" : "s"}?`}
          body="Each thread's turn is held where it is; Resume on a row brings it back."
          confirmLabel="Pause all"
          onCancel={() => setPausing(false)}
          onConfirm={async () => {
            await byHost(toPause, "pause");
            setPausing(false);
          }}
        />
      ) : null}
    </div>
  );
}
