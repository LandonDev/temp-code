import { useMemo, useState } from "react";
import { STATUS_WORD, StatusMark } from "../components/ui/status";
import { Button } from "../components/ui/button";
import { Popover, PopoverTrigger } from "../components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/cn";
import { aliasKeys } from "../lib/linkedRail";
import { useLastSeen, useSeenFloor } from "../lib/sessionSeen";
import { workspaceMarks, type GroupMark, type WorkspaceMark } from "../lib/sidebarRows";
import { useSessionMetas } from "../lib/tcserver/store";
import { useWorkspaceCatalog } from "../lib/tcserver/workspaces";
import type { ThreadRow } from "../lib/workspaceSessions";
import { ProjectLogoIcon } from "./ProjectLogoIcon";
import { ProjectMascot } from "./ProjectMascot";
import { WorkspaceThreadsPopover } from "./WorkspaceThreadsPopover";

/**
 * A workspace row's marks, owned by the status area (A2): the glyph (logo
 * or mascot), the word at the row's end and the line under it naming the
 * thread behind the word. The rail (ProjectRail.tsx) places them and never
 * styles them.
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

/** The row's 16px glyph: the logo (set, or the repo icon), else the
 *  mascot in the workspace's colour. Never animated, never recoloured by
 *  the workspace's state: the word at the row's end says that. */
export function WorkspaceGlyph({
  showLogo,
  logoPath,
  workspaceId,
  projectKey,
  color,
  mascotName,
}: {
  showLogo: boolean;
  logoPath: string | null | undefined;
  workspaceId: string | null;
  projectKey: string;
  color: string;
  mascotName: string | null | undefined;
}) {
  return showLogo ? (
    <ProjectLogoIcon path={logoPath ?? null} workspaceId={workspaceId} />
  ) : (
    <ProjectMascot project={projectKey} color={color} name={mascotName ?? null} />
  );
}

const threadCount = (n: number) => `${n} ${n === 1 ? "thread" : "threads"}`;

/** The word itself: a ghost button holding the StatusMark, named with its
 *  count. In a rail narrower than 15rem the word gives way to the name: the
 *  glyph stays, and the button's name and the line under the row still say
 *  it (the rail row is the `railrow` container, ProjectRail.tsx). */
export function WorkspaceMarkView({ mark, ...props }: { mark: GroupMark<ThreadRow> } & React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant="ghost"
      size="xs"
      data-no-drag
      aria-label={`${STATUS_WORD[mark.state]}, ${threadCount(mark.more + 1)}`}
      {...props}
      className={cn("h-6 px-1.5 hover:bg-foreground/7 aria-expanded:bg-foreground/7", props.className)}
    >
      <StatusMark state={mark.state} wordClassName="@max-[15rem]/railrow:hidden" />
    </Button>
  );
}

/** The word at a workspace row's end; a click opens the workspace's
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

/** The line under a workspace row: the thread behind its word, `+N` when
 *  more share the state (their names on hover); a click opens the thread. */
export function WorkspaceLineView({
  mark,
  onSelect,
}: {
  mark: GroupMark<ThreadRow>;
  onSelect?: (sessionId: string) => void;
}) {
  const title = mark.about.title || "Untitled";
  return (
    <Button
      variant="ghost"
      size="xs"
      data-no-drag
      data-workspace-line
      onClick={(event) => {
        event.stopPropagation();
        onSelect?.(mark.about.id);
      }}
      className="h-6 w-full justify-start gap-2 pr-3 pl-9 text-[12px] font-normal text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
    >
      <span className="min-w-0 flex-1 truncate text-left">{title}</span>
      {mark.more > 0 ? (
        <Tooltip>
          <TooltipTrigger render={<span className="shrink-0 tabular-nums" />}>+{mark.more}</TooltipTrigger>
          <TooltipContent side="right">{mark.others.map((t) => t.title || "Untitled").join("\n")}</TooltipContent>
        </Tooltip>
      ) : null}
    </Button>
  );
}
