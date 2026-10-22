import { useMemo, useState } from "react";
import { ConfirmDialog } from "../../chrome/ConfirmDialog";
import { ChevronRight, Plus } from "../../chrome/icons";
import { useEnvironments } from "../../lib/connection/status";
import * as commands from "../../lib/tcserver/commands";
import type { SessionMeta } from "../../lib/tcserver/types";
import { hasRunningTurn } from "../../lib/threadBatch";
import { useMetaById } from "../../lib/threads/agents";
import { PaneHeader } from "./bits";
import { chatOf } from "./chatSlots";
import { AddThreadDialog } from "./master/AddThreadDialog";
import { BatchFoot } from "./master/BatchFoot";
import { ChildPane } from "./master/ChildPane";
import { MasterRow } from "./master/MasterRow";
import { setBatchRules, stopBatchStep, useMasterModel } from "./master/useMasterModel";
import { SplitShell } from "./SplitShell";
import type { ThreadViewProps } from "./ThreadView";

/**
 * The project's master thread (CLAUDE.md "Master threads", docs/LAYOUT.md
 * "Master"): the batch board on the left, the master's own chat on the
 * right on the SplitShell recipe, the chat folding to the edge tab as
 * elsewhere. A row opens its thread in the right pane in the chat's
 * place, with Back to the chat. Until the master has a first child the
 * chat is the whole view, the way an orchestration thread opens.
 */

const QUIET_BUTTON =
  "pressable h-6 rounded-md px-2 text-xs text-content/50 hover:bg-content/5 hover:text-content disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent";
const BORDERED_BUTTON =
  "pressable inline-flex h-6 items-center gap-1 rounded-md border border-content/10 px-2 text-xs text-content hover:bg-content/5";

/** The children Pause all would reach: a running turn anywhere in their
 *  tree, by the fleet switches' rule (lib/threadBatch.ts). */
export function pausable(children: readonly SessionMeta[]): SessionMeta[] {
  return children.filter(hasRunningTurn);
}

export function MasterView(props: ThreadViewProps) {
  const { session } = props;
  const meta = useMetaById(session.id);
  const model = useMasterModel(session);
  const { rows, groups, batch, landed, openId, setOpenId, now } = model;
  const environments = useEnvironments();
  const hostNames = useMemo(() => new Map(environments.map((e) => [e.id, e.name])), [environments]);
  const [chatOpen, setChatOpen] = useState(true);
  const [adding, setAdding] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [focusComposer, setFocusComposer] = useState(false);
  const children = useMemo(() => rows.map((r) => r.meta), [rows]);
  const hasBoard = rows.length > 0;
  const toPause = pausable(children);

  if (!hasBoard) {
    return <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">{chatOf(props)}</div>;
  }

  const pauseAll = async () => {
    const byHost = new Map<string, string[]>();
    for (const c of toPause) (byHost.get(c.environmentId) ?? byHost.set(c.environmentId, []).get(c.environmentId)!).push(c.id);
    await Promise.allSettled([...byHost].map(([env, ids]) => commands.sessionBatch(env, "pause", ids)));
  };

  const open = (id: string, focus = false) => {
    setFocusComposer(focus);
    setOpenId(id);
    setChatOpen(true);
  };

  const title = meta?.title || session.title || "Master";
  const board = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-content/10 px-3.5 whitespace-nowrap">
        <span className="min-w-0 truncate text-[13px] font-medium text-content">{title}</span>
        <span className="flex-1" />
        <button type="button" onClick={() => setPausing(true)} disabled={toPause.length === 0} className={QUIET_BUTTON}>
          Pause all
        </button>
        <button type="button" onClick={() => setAdding(true)} className={BORDERED_BUTTON}>
          <Plus className="size-3" strokeWidth={2} />
          Thread
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pt-1 pb-3">
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
                  open={openId === row.meta.id}
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
        onStop={() => stopBatchStep(session.environmentId, session.id)}
      />
    </div>
  );

  const chat = openId ? (
    <ChildPane
      key={openId}
      sessionId={openId}
      focusComposer={focusComposer}
      onBack={() => setOpenId(null)}
      onOpenFile={props.onOpenFile}
      onOpenDiff={props.onOpenDiff}
      onOpenSession={props.onOpenSession}
    />
  ) : (
    <>
      <PaneHeader label="Conversation">
        <button
          type="button"
          onClick={() => setChatOpen(false)}
          title="Hide conversation"
          aria-label="Hide conversation"
          className="pressable grid size-6 place-items-center rounded-md text-content/50 hover:bg-content/5 hover:text-content"
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
      {adding && meta ? <AddThreadDialog master={meta} siblings={children} onClose={() => setAdding(false)} /> : null}
      {pausing ? (
        <ConfirmDialog
          title={`Pause ${toPause.length} running thread${toPause.length === 1 ? "" : "s"}?`}
          body="Each thread's turn is held where it is; Resume on a row brings it back."
          confirmLabel="Pause all"
          onCancel={() => setPausing(false)}
          onConfirm={async () => {
            await pauseAll();
            setPausing(false);
          }}
        />
      ) : null}
    </div>
  );
}
