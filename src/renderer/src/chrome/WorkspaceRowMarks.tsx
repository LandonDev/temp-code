import { useMemo, useState } from "react";
import { STATUS_WORD, StatusMark } from "../components/ui/status";
import { Button } from "../components/ui/button";
import { Popover, PopoverTrigger } from "../components/ui/popover";
import { cn } from "../lib/cn";
import { aliasKeys } from "../lib/linkedRail";
import { useLastSeen, useSeenFloor } from "../lib/sessionSeen";
import { workspaceMarks, type GroupMark, type WorkspaceMark } from "../lib/sidebarRows";
import { useSessionMetas } from "../lib/tcserver/store";
import { useWorkspaceCatalog } from "../lib/tcserver/workspaces";
import type { ThreadRow } from "../lib/workspaceSessions";
import { WorkspaceThreadsPopover } from "./WorkspaceThreadsPopover";

/**
 * A workspace row's mark, owned by the status area (A2): the state's glyph
 * at the row's end, opening the workspace's threads. The rail
 * (ProjectRail.tsx) places it and never styles it; Working names the
 * threads.
 */

/** The rail's mark per workspace, keyed by the row's lead path (a linked
 *  workspace's copies read as one), recomputed only when the metas,
 *  catalog or seen state change. */
export function useWorkspaceMarks(): Map<string, WorkspaceMark> {
  const catalog = useWorkspaceCatalog();
  const metas = useSessionMetas();
  const lastSeen = useLastSeen();
  const floor = useSeenFloor();
  return useMemo(
    () => workspaceMarks(metas, catalog, lastSeen, floor, aliasKeys(catalog.workspaces).path),
    [metas, catalog, lastSeen, floor],
  );
}

/** The selected workspace's uncommitted lines as the rail says them, plain:
 *  `+212 −48`, a side left out when it is zero. */
export function diffWords(additions: number, deletions: number): string {
  return [additions > 0 ? `+${additions}` : "", deletions > 0 ? `−${deletions}` : ""].filter(Boolean).join(" ");
}

const threadCount = (n: number) => `${n} ${n === 1 ? "thread" : "threads"}`;

/** The state's glyph alone, in a 24px ghost button named with its word and
 *  count ("Needs you, 4 threads"); never a word, at any width. */
export function WorkspaceMarkView({ mark, ...props }: { mark: GroupMark<ThreadRow> } & React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      data-no-drag
      aria-label={`${STATUS_WORD[mark.state]}, ${threadCount(mark.more + 1)}`}
      {...props}
      className={cn("hover:bg-foreground/7 aria-expanded:bg-foreground/7", props.className)}
    >
      <StatusMark state={mark.state} word={false} />
    </Button>
  );
}

/** The state's glyph at a workspace row's end; a click opens the workspace's
 *  threads beside the rail. A pointer-down never reaches the row's drag. */
export function WorkspaceMarkTrigger({
  mark,
  workspaceIds,
  activeSessionId,
  onSelectThread,
}: {
  mark: GroupMark<ThreadRow>;
  /** The rail row's workspace and its copies on other hosts, the leader's first. */
  workspaceIds: readonly string[];
  activeSessionId: string | null;
  onSelectThread?: (sessionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <WorkspaceMarkView
            mark={mark}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          />
        }
      />
      {open && workspaceIds.length > 0 ? (
        <WorkspaceThreadsPopover
          workspaceIds={workspaceIds}
          activeSessionId={activeSessionId}
          onSelectThread={(sessionId) => {
            setOpen(false);
            onSelectThread?.(sessionId);
          }}
        />
      ) : null}
    </Popover>
  );
}
