import { useMemo, useState } from "react";
import { Popover, type PopoverAnchor } from "./Popover";
import { LiveLines, RowShell, TaskLine, ThreadGlyph } from "./WorkspaceSessions";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { blockedThreads, cardTasks, projectCardStatus } from "../lib/projectCardModel";
import { useLastSeen, useSeenFloor } from "../lib/sessionSeen";
import { useSessionMetas } from "../lib/tcserver/store";
import { useWorkspaceCatalog } from "../lib/tcserver/workspaces";
import {
  groupWorkspaceSessions,
  rowCache,
  type ThreadRow,
  type WorkspaceSessionGroups,
} from "../lib/workspaceSessions";

const POPOVER_WIDTH = 300;
const POPOVER_MAX_HEIGHT = 360;

type Section = { key: string; label: string; threads: ThreadRow[] };

/** `LiveLines` only prints running/paused/unread — a waiting or failed
 *  thread is a count there, not a row. This popover's whole point is to
 *  show which thread is blocked, so it gets its own two rows, same visual
 *  language as `StatusDot`'s waiting (pulsing amber) and failed (red). */
function BlockedLine({
  thread: t,
  kind,
  onSelect,
}: {
  thread: ThreadRow;
  kind: "waiting" | "failed";
  onSelect?: (id: string) => void;
}) {
  const tasks = kind === "waiting" ? cardTasks(t) : null;
  const tone = kind === "waiting" ? "text-warning" : "text-danger";
  const dot = kind === "waiting" ? "bg-warning motion-safe:animate-pulse" : "bg-danger";
  return (
    <RowShell className="w-full py-1" onSelect={onSelect ? () => onSelect(t.id) : undefined}>
      <div className={`flex w-full items-center gap-1.5 text-[11px] leading-4 ${tone}`}>
        <span className={`size-1.5 shrink-0 rounded-full ${dot}`} />
        <ThreadGlyph thread={t} />
        <span className="min-w-0 flex-1 truncate text-content">{t.title || "Untitled"}</span>
        <span className="shrink-0 font-medium">{kind === "waiting" ? "Needs you" : "Failed"}</span>
      </div>
      {tasks ? <TaskLine tasks={tasks} /> : null}
    </RowShell>
  );
}

/** Every chat a workspace holds, grouped by the project it lives in — a
 *  loose chat gets none. Pure and prop-driven, so it tests the way
 *  `LiveLines` does: no store, no popover chrome. */
export function workspaceThreadSections(groups: WorkspaceSessionGroups): Section[] {
  return [
    ...groups.projects
      .filter((g) => g.threads.length > 0)
      .map((g) => ({ key: g.project.id, label: g.project.name, threads: g.threads })),
    ...(groups.chats.length > 0
      ? [{ key: "chats", label: "Chats", threads: groups.chats }]
      : []),
  ];
}

/** The popover's content: one labeled section per project, then a trailing
 *  "Chats" section for threads with none, each rendered with the same
 *  running/paused/unread lines the Sessions tab's own project card uses —
 *  so a row here never disagrees with what you see after switching in. */
export function WorkspaceThreadsList({
  groups,
  activeSessionId,
  lastSeen,
  seenFloor,
  onSelectThread,
}: {
  groups: WorkspaceSessionGroups;
  activeSessionId: string | null;
  lastSeen: Record<string, number>;
  seenFloor: number;
  onSelectThread: (sessionId: string) => void;
}) {
  const sections = workspaceThreadSections(groups)
    .map((section) => ({
      ...section,
      blocked: blockedThreads(section.threads),
      status: projectCardStatus(section.threads, activeSessionId, lastSeen, seenFloor),
    }))
    // A project with only dormant, long-seen threads has nothing to show
    // here; skip its section rather than print an empty label.
    .filter(
      (section) =>
        section.blocked.length > 0 ||
        section.status.running.length > 0 ||
        section.status.paused.length > 0 ||
        section.status.unread.length > 0,
    );
  return (
    <div className="flex flex-col gap-2 p-1">
      {sections.map((section) => (
        <div key={section.key} className="flex flex-col">
          <span className="px-2 py-1 text-[11px] font-semibold tracking-[0.08em] text-content/50 uppercase">
            {section.label}
          </span>
          {section.blocked.length > 0 ? (
            <div className="w-full divide-y divide-content/10 border-y border-content/10">
              {section.blocked.map(({ kind, thread }) => (
                <BlockedLine
                  key={thread.id}
                  thread={thread}
                  kind={kind}
                  onSelect={onSelectThread}
                />
              ))}
            </div>
          ) : null}
          <LiveLines status={section.status} activeId={activeSessionId} onSelectThread={onSelectThread} />
        </div>
      ))}
    </div>
  );
}

/**
 * What the rail's status chip opens: `WorkspaceThreadsList` wired to the
 * live stores and anchored to the chip with `Popover`.
 */
export function WorkspaceThreadsPopover({
  anchor,
  workspaceId,
  activeSessionId,
  onSelectThread,
  onDismiss,
}: {
  anchor: PopoverAnchor;
  workspaceId: string;
  activeSessionId: string | null;
  onSelectThread: (sessionId: string) => void;
  onDismiss: () => void;
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
        workspaceId,
        lastSeen,
        seenFloor,
        cache,
      ),
    [cache, lastSeen, metas, projects, seenFloor, workspaceId, workspaces],
  );

  return (
    <Popover
      anchor={anchor}
      side="right"
      align="start"
      width={POPOVER_WIDTH}
      maxHeight={POPOVER_MAX_HEIGHT}
      autoFocus
      onDismiss={onDismiss}
      role="menu"
      aria-label="This workspace's threads"
      className="flex flex-col overflow-hidden p-1"
    >
      <div ref={lockList} className="overflow-y-auto overscroll-none">
        <WorkspaceThreadsList
          groups={groups}
          activeSessionId={activeSessionId}
          lastSeen={lastSeen}
          seenFloor={seenFloor}
          onSelectThread={onSelectThread}
        />
      </div>
    </Popover>
  );
}
