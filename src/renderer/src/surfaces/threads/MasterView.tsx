import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../../chrome/ConfirmDialog";
import { ExplorerMenu } from "../../chrome/ExplorerMenu";
import { ChevronDown, ChevronRight, MoreHorizontal, Plus } from "../../chrome/icons";
import { useEnvironments } from "../../lib/connection/status";
import * as commands from "../../lib/tcserver/commands";
import { useSessionMetasWhen } from "../../lib/tcserver/store";
import type { SessionMeta } from "../../lib/tcserver/types";
import { resourcesHeldBy } from "../../lib/threadBatch";
import { useMetaById } from "../../lib/threads/agents";
import { PaneHeader } from "./bits";
import { chatOf } from "./chatSlots";
import { AddThreadDialog } from "./master/AddThreadDialog";
import { AdoptThreadDialog } from "./master/AdoptThreadDialog";
import { ArchiveBatchDialog } from "./master/ArchiveBatchDialog";
import { BatchFoot } from "./master/BatchFoot";
import { addMenuItems, adoptCandidates, boardMenuItems, doneRows, pausableRows, pausedRows, type ArchiveWhich } from "./master/boardActions";
import { ChildPane } from "./master/ChildPane";
import { MasterRow } from "./master/MasterRow";
import { adoptThreads, archiveBatch, setBatchRules, stopBatchStep, useMasterModel } from "./master/useMasterModel";
import { SplitShell } from "./SplitShell";
import type { ThreadViewProps } from "./ThreadView";

/**
 * A master thread (CLAUDE.md "Master threads", docs/LAYOUT.md "Master"):
 * the batch board on the left, the master's own chat on the right on the
 * SplitShell recipe, the chat folding to the edge tab as elsewhere. A row
 * opens its thread's full view in the whole pane with one Back control
 * (Escape and ⌘↩ too); the board comes back at the scroll it was left at.
 * Until the master has a first child the chat is the whole view, the way
 * an orchestration thread opens.
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

const menuAt = (el: HTMLElement, kind: Menu["kind"]): Menu => {
  const rect = el.getBoundingClientRect();
  return { kind, x: rect.left, y: rect.bottom + 4 };
};

export function MasterView(props: ThreadViewProps) {
  const { session } = props;
  const meta = useMetaById(session.id);
  const model = useMasterModel(session);
  const { rows, groups, batch, landed, openId, setOpenId, now } = model;
  const environments = useEnvironments();
  const hostNames = useMemo(() => new Map(environments.map((e) => [e.id, e.name])), [environments]);
  const [chatOpen, setChatOpen] = useState(true);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [adding, setAdding] = useState(false);
  const [adopting, setAdopting] = useState(false);
  const [archiving, setArchiving] = useState<ArchiveWhich | null>(null);
  const [pausing, setPausing] = useState(false);
  const [focusComposer, setFocusComposer] = useState(false);
  const children = useMemo(() => rows.map((r) => r.meta), [rows]);
  const hasBoard = rows.length > 0;
  const toPause = pausableRows(rows);
  const paused = pausedRows(rows);
  const done = doneRows(rows);
  // The adopt candidates are read only while the add menu or its sheet is up.
  const metas = useSessionMetasWhen(menu?.kind === "add" || adopting);
  const candidates = useMemo(() => (meta ? adoptCandidates(metas, meta) : []), [metas, meta]);

  // The board's scroll offset survives a trip into a child's full view.
  const scroller = useRef<HTMLDivElement>(null);
  const savedScroll = useRef(0);
  useLayoutEffect(() => {
    if (!openId && scroller.current) scroller.current.scrollTop = savedScroll.current;
  }, [openId]);

  if (!hasBoard) {
    return <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">{chatOf(props)}</div>;
  }

  const byHost = (list: readonly { meta: SessionMeta }[], action: "pause" | "resume") => {
    const map = new Map<string, string[]>();
    for (const { meta: c } of list) (map.get(c.environmentId) ?? map.set(c.environmentId, []).get(c.environmentId)!).push(c.id);
    return Promise.allSettled([...map].map(([env, ids]) => commands.sessionBatch(env, action, ids)));
  };

  const open = (id: string, focus = false) => {
    savedScroll.current = scroller.current?.scrollTop ?? 0;
    setFocusComposer(focus);
    setOpenId(id);
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

  if (openId) {
    return (
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <ChildPane
          key={openId}
          sessionId={openId}
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
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-2.5 pt-1 pb-3" data-board-scroller>
        {groups.map((group) => (
          <section key={group.id} aria-label={group.label} data-group={group.id}>
            <h3 className="flex items-baseline gap-2 px-3 pt-4 pb-1.5 text-xs font-normal text-content/40">
              {group.label}
              <span className="tabular-nums text-content/30">{group.rows.length}</span>
            </h3>
            <div className="flex flex-col gap-px">
              {group.rows.map((row) => (
                <MasterRow
                  key={row.key}
                  row={row}
                  now={now}
                  fleetSize={rows.length}
                  landed={landed.has(row.meta.id)}
                  hostName={
                    row.meta.environmentId !== session.environmentId
                      ? (hostNames.get(row.meta.environmentId) ?? row.meta.environmentId)
                      : null
                  }
                  onOpen={open}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
      <BatchFoot
        batch={batch}
        titleOf={(id) => rows.find((r) => r.meta.id === id)?.title}
        onSave={(next) => setBatchRules(session.environmentId, session.id, next)}
        onStop={(stepId) => stopBatchStep(session.environmentId, session.id, stepId)}
      />
    </div>
  );

  const chat = (
    <>
      <PaneHeader label="Conversation">
        <button
          type="button"
          onClick={() => setChatOpen(false)}
          title="Hide conversation"
          aria-label="Hide conversation"
          className={QUIET_ICON}
        >
          <ChevronRight className="size-3.5" strokeWidth={1.75} />
        </button>
      </PaneHeader>
      {chatOf(props)}
    </>
  );

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <SplitShell
        board={board}
        chat={chat}
        hasBoard
        collapsed={!chatOpen}
        onOpenChat={() => setChatOpen(true)}
        status={meta?.status ?? session.status}
        edgeTitle="Show conversation"
      />
      {menu ? (
        <ExplorerMenu
          x={menu.x}
          y={menu.y}
          ariaLabel={menu.kind === "board" ? "Batch actions" : "Add a thread"}
          items={
            menu.kind === "board"
              ? boardMenuItems({ pausable: toPause.length, paused: paused.length, done: done.length, all: rows.length })
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
          onClose={() => setAdopting(false)}
          onAdopt={(ids) => adoptThreads(session.environmentId, session.id, ids)}
        />
      ) : null}
      {archiving ? (
        <ArchiveBatchDialog
          which={archiving}
          count={archiving === "done" ? done.length : rows.length}
          resources={resourcesHeldBy((archiving === "done" ? done : rows).map((r) => r.meta.id))}
          onCancel={() => setArchiving(null)}
          onConfirm={(removeResources) => archiveBatch(session.environmentId, session.id, archiving, removeResources)}
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
