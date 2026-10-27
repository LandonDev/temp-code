import { lazy, Suspense, useContext, useMemo } from "react";
import { Button } from "@renderer/components/ui/button";
import { Spinner } from "@renderer/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@renderer/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { X } from "../chrome/icons";
import { BuildPanel } from "../chrome/rail/BuildPanel";
import { ChangesPanel } from "../chrome/rail/ChangesPanel";
import { DevServerPanel } from "../chrome/rail/DevServerPanel";
import { FileTree } from "../chrome/FileTree";
import { useDragResize } from "../hooks/useDragResize";
import { useGitFileStatuses } from "../hooks/useGitFileStatuses";
import { useDevRunning } from "../lib/devServers";
import {
  PANEL_MAX,
  PANEL_MIN,
  PANEL_WIDTH,
  rightPanel,
  SECTION_LABEL,
  sectionsFor,
  shownSection,
  useRightPanel,
  type PanelFacts,
  type PanelState,
  type Section,
} from "../lib/rightPanel";
import type { OpenFileFn } from "../lib/search";
import type { Session } from "../lib/session";
import { projectForCwd } from "../lib/tcserver/projects";
import type { ProjectMeta } from "../lib/tcserver/types";
import { useProjects } from "../lib/tcserver/workspaces";
import { fleetCounts, useAgents, useMetaById } from "../lib/threads/agents";
import { useActivity } from "../lib/activity";
import { ActivitySection } from "./threads/ActivitySection";
import { FleetList } from "./threads/fleet/FleetPanel";
import { NotesBody } from "./threads/NotesPanel";
import { SessionActionsContext } from "./threadChat";

// The Debug section drives the editor chunk's DAP session; it loads with it.
const DebugPanel = lazy(() => import("../chrome/rail/DebugPanel"));
// Listed for a dev build, and for any thread that asked for it ("Debug this file").
const DEBUG_SECTION = import.meta.env.DEV;

export type RightPanelProps = {
  session: Session;
  onOpenFile: OpenFileFn;
  onOpenDiff: (path?: string) => void;
  onOpenSession?: (sessionId: string) => void;
  /** The review file the focused tab shows, relative to the git root. */
  selectedPath?: string;
};

/**
 * The one column at a root thread's right edge (docs/LAYOUT.md "The right
 * side"): a 36px header of the sections that exist for the thread's state
 * and a close button, the section's body under it. It toggles, never
 * tweens its width; the body fades in over `--dur-fast`. Closed is closed:
 * the thread header's button and ⌘⇧R reopen it on its last section.
 */
export function RightPanel(props: RightPanelProps) {
  const { session } = props;
  const state = useRightPanel(session.id);
  const facts = usePanelFacts(session, state);
  const available = useMemo(() => sectionsFor(facts.facts), [facts.facts]);
  const section = shownSection(state.section, available);

  const resize = useDragResize({
    edge: "left",
    min: PANEL_MIN,
    max: () => Math.min(PANEL_MAX, Math.floor(window.innerWidth * 0.5)),
    defaultWidth: PANEL_WIDTH,
    initial: state.width,
    onCommit: (next) => rightPanel.setWidth(session.id, next),
  });

  if (!state.open || !section) return null;

  return (
    <aside
      ref={resize.setPaneRef}
      aria-label="Thread panel"
      className="relative flex shrink-0 flex-col border-l border-border bg-sidebar"
      style={{ width: state.width, contain: "strict" }}
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border pr-1.5 pl-2">
        <Tabs
          value={section}
          onValueChange={(next) => rightPanel.set(session.id, { section: next as Section })}
          className="min-w-0 flex-1"
        >
          <TabsList variant="line" className="h-9 w-full justify-start overflow-x-auto">
            {available.sections.map((s) => (
              <TabsTrigger key={s} value={s} className="h-9 flex-none text-[12px]">
                {SECTION_LABEL[s]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Hide panel"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => rightPanel.close(session.id)}
              />
            }
          >
            <X className="size-3.5" strokeWidth={1.75} />
          </TooltipTrigger>
          <TooltipContent>Hide panel ⌘⇧R</TooltipContent>
        </Tooltip>
      </div>
      <div
        key={section}
        className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-(--dur-fast) flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        <SectionBody section={section} project={facts.project} {...props} />
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        aria-valuenow={resize.width}
        aria-valuemin={PANEL_MIN}
        aria-valuemax={PANEL_MAX}
        className={`absolute inset-y-0 -left-px z-10 w-1.5 cursor-col-resize touch-none ${
          resize.dragging ? "bg-foreground/12" : "hover:bg-foreground/7"
        }`}
        onPointerDown={resize.onPointerDown}
        onDoubleClick={resize.onDoubleClick}
      />
    </aside>
  );
}

/** The thread's state as the facts `sectionsFor` reads, and the project the sections key by. */
function usePanelFacts(session: Session, state: PanelState): { facts: PanelFacts; project: ProjectMeta | undefined } {
  const agents = useAgents(session.id);
  const meta = useMetaById(session.id);
  const projects = useProjects();
  const project =
    (session.cwd && session.cwd !== "~" ? projectForCwd(session.cwd, projects) : undefined) ??
    projects.find((p) => p.id === session.projectId && p.environmentId === session.environmentId);
  const devRunning = useDevRunning(project?.id);
  const activity = useActivity(session.id).rows;
  const counts = fleetCounts(agents);
  const status = meta?.status ?? session.status;
  const facts = useMemo<PanelFacts>(
    () => ({
      root: !session.parentId,
      project: !!project?.cwd,
      agents: agents.length,
      liveAgents: counts.working + counts.waiting,
      // The rows A6 joins: background tasks, subagents, a batch, dev servers and Mac bridge calls.
      backgroundTasks: activity.length,
      watching: status === "watching",
      devRunning,
      debug: DEBUG_SECTION || state.debug,
    }),
    [session, project, agents.length, counts.working, counts.waiting, status, devRunning, activity.length, state.debug],
  );
  return { facts, project };
}

function SectionBody({
  section,
  project,
  session,
  onOpenFile,
  onOpenDiff,
  onOpenSession,
  selectedPath,
}: RightPanelProps & { section: Section; project: ProjectMeta | undefined }) {
  const cwd = project?.cwd ?? session.cwd;
  const gitStatuses = useGitFileStatuses(cwd, section === "files");
  const actions = useContext(SessionActionsContext);
  switch (section) {
    case "activity":
      return <ActivitySection threadId={session.id} onOpenAgents={() => rightPanel.open(session.id, "agents")} />;
    case "agents":
      return (
        <FleetList
          sessionId={session.id}
          parentCwd={session.cwd}
          onOpenSession={onOpenSession}
          onOpenFile={onOpenFile}
          onOpenDiff={onOpenDiff}
        />
      );
    case "notes":
      return <NotesBody session={session} />;
    case "changes":
      return <ChangesPanel cwd={cwd} selectedPath={selectedPath} onOpenDiff={onOpenDiff} onOpenFile={onOpenFile} />;
    case "files":
      return (
        <FileTree
          key={cwd}
          cwd={cwd}
          onOpenFile={onOpenFile}
          onFileMoved={actions?.onFileMoved}
          onFileDeleted={actions?.onFileDeleted}
          gitStatuses={gitStatuses}
        />
      );
    case "build":
      return project ? <BuildPanel projectId={project.id} /> : null;
    case "dev":
      return project ? <DevServerPanel projectId={project.id} /> : null;
    case "debug":
      return (
        <Suspense
          fallback={
            <div className="flex h-16 items-center justify-center">
              <Spinner className="size-3.5 text-muted-foreground" />
            </div>
          }
        >
          <DebugPanel />
        </Suspense>
      );
  }
}
