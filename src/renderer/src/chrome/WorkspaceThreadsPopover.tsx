import { useMemo, useState } from "react";
import { PopoverContent } from "../components/ui/popover";
import type { ThreadState } from "../components/ui/status";
import { ThreadRowView } from "./WorkspaceSessions";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { cn } from "../lib/cn";
import { useLastSeen, useSeenFloor } from "../lib/sessionSeen";
import { masterBlock, rowState, type MasterBlock } from "../lib/sidebarRows";
import { useSessionMetas } from "../lib/tcserver/store";
import { useWorkspaceCatalog } from "../lib/tcserver/workspaces";
import { agentSummaryParts, type AgentSummary } from "../lib/threads/agents";
import { marksAtRest } from "../lib/threadStripModel";
import {
  cardThreads,
  groupWorkspaceSessions,
  rowCache,
  type ThreadRow,
  type WorkspaceSessionGroups,
} from "../lib/workspaceSessions";

/** `threads` is every root with each master's batch beside it
 *  (`cardThreads`), `roots` what the rows print (a master with its batch
 *  under it). */
type Section = { key: string; label: string; threads: ThreadRow[]; roots: ThreadRow[] };

/** Every chat a workspace holds, grouped by the project it lives in — a
 *  loose chat gets none. */
export function workspaceThreadSections(groups: WorkspaceSessionGroups): Section[] {
  return [
    ...groups.projects
      .filter((g) => g.threads.length > 0)
      .map((g) => ({ key: g.project.id, label: g.project.name, threads: cardThreads(g.threads), roots: g.threads })),
    ...(groups.chats.length > 0
      ? [{ key: "chats", label: "Chats", threads: groups.chats, roots: groups.chats }]
      : []),
  ];
}

const RANK: Record<ThreadState, number> = {
  waiting: 0,
  failed: 1,
  working: 2,
  watching: 2,
  paused: 3,
  "plan-ready": 4,
  stopped: 5,
  queued: 6,
  done: 7,
  idle: 7,
};

type Entry =
  | { kind: "row"; id: string; rank: number; row: ThreadRow }
  | { kind: "master"; id: string; rank: number; block: MasterBlock };

/** What a section prints, blocked first: every root with a mark or unread,
 *  and each master with something to say as one block. A thread inside a
 *  master prints only in its block. */
export function sectionEntries(roots: readonly ThreadRow[]): Entry[] {
  const out: Entry[] = [];
  for (const row of roots) {
    if (row.housed) continue;
    const block = masterBlock(row, row.unread);
    if (block) {
      const rank = Math.min(RANK[block.state], ...block.lines.map((l) => RANK[l.state]));
      out.push({ kind: "master", id: row.id, rank, block });
      continue;
    }
    const state = rowState(row);
    if (marksAtRest(state) || row.unread) out.push({ kind: "row", id: row.id, rank: RANK[state], row });
  }
  return out.sort((a, b) => a.rank - b.rank);
}

/** A thread's working subagents in the fleet's words, two spaces apart,
 *  aligned with its title. */
function AgentsLine({ summary, className }: { summary: AgentSummary; className: string }) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2 pb-1 text-[12px] text-muted-foreground", className)}>
      {agentSummaryParts(summary).map((part) => (
        <span key={part.text} className={cn("shrink-0 truncate", part.tone)}>
          {part.text}
        </span>
      ))}
    </div>
  );
}

/** A master and its batch as one block: its row with the done tally, its
 *  own working subagents, then each batch thread with something to say
 *  one step in, loudest first, and the queued ones as one count. */
function MasterRows({ block, activeId, onSelect }: { block: MasterBlock; activeId: string | null; onSelect: (id: string) => void }) {
  return (
    <div className="flex flex-col">
      <ThreadRowView row={block.master} word selected={block.master.id === activeId} onOpen={() => onSelect(block.master.id)} />
      {block.agents ? <AgentsLine summary={block.agents} className="pl-9" /> : null}
      {block.lines.map(({ thread, agents }) => (
        <div key={thread.id} className="flex flex-col">
          <ThreadRowView row={thread} child word selected={thread.id === activeId} onOpen={() => onSelect(thread.id)} />
          {agents ? <AgentsLine summary={agents} className="pl-15" /> : null}
        </div>
      ))}
      {block.queued > 0 ? (
        <div className="flex h-7 items-center pl-15 text-[12px] text-muted-foreground">{block.queued} queued</div>
      ) : null}
    </div>
  );
}

/** The popover's content: one section per project under its name, then a
 *  trailing Chats section for threads with none; each row says its word,
 *  since saying which thread is blocked is the popover's job. A project
 *  with nothing to say is left out. */
export function WorkspaceThreadsList({
  groups,
  activeSessionId,
  onSelectThread,
}: {
  groups: WorkspaceSessionGroups;
  activeSessionId: string | null;
  onSelectThread: (sessionId: string) => void;
}) {
  const sections = workspaceThreadSections(groups)
    .map((section) => ({ ...section, entries: sectionEntries(section.roots) }))
    .filter((section) => section.entries.length > 0);
  return (
    <div className="flex flex-col gap-2">
      {sections.map((section) => (
        <div key={section.key} className="flex flex-col">
          <span className="flex h-7 items-center px-3 text-[12px] font-medium text-muted-foreground">{section.label}</span>
          {section.entries.map((entry) =>
            entry.kind === "master" ? (
              <MasterRows key={entry.id} block={entry.block} activeId={activeSessionId} onSelect={onSelectThread} />
            ) : (
              <ThreadRowView
                key={entry.id}
                row={entry.row}
                word
                selected={entry.id === activeSessionId}
                onOpen={() => onSelectThread(entry.id)}
              />
            ),
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * What a rail row's word opens: `WorkspaceThreadsList` wired to the live
 * stores, as the content of the word's `Popover` (WorkspaceRowMarks.tsx).
 */
export function WorkspaceThreadsPopover({
  workspaceIds,
  activeSessionId,
  onSelectThread,
}: {
  /** The rail row's workspace and its copies on other hosts, the leader's first. */
  workspaceIds: readonly string[];
  activeSessionId: string | null;
  onSelectThread: (sessionId: string) => void;
}) {
  const metas = useSessionMetas();
  const { workspaces, projects } = useWorkspaceCatalog();
  const lastSeen = useLastSeen();
  const seenFloor = useSeenFloor();
  const [cache] = useState(rowCache);
  const lockList = useLockOverscroll<HTMLDivElement>();

  const groups = useMemo(
    () =>
      groupWorkspaceSessions(
        metas,
        projects,
        workspaces,
        workspaceIds.length > 1 ? workspaceIds : workspaceIds[0],
        lastSeen,
        seenFloor,
        cache,
      ),
    [cache, lastSeen, metas, projects, seenFloor, workspaceIds, workspaces],
  );

  return (
    <PopoverContent
      side="right"
      align="start"
      aria-label="This workspace's threads"
      className="max-h-90 w-75 gap-0 overflow-hidden p-1"
    >
      <div ref={lockList} className="overflow-y-auto overscroll-none">
        <WorkspaceThreadsList groups={groups} activeSessionId={activeSessionId} onSelectThread={onSelectThread} />
      </div>
    </PopoverContent>
  );
}
