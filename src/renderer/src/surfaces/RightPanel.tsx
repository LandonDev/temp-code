import { lazy, Suspense, useContext, useEffect, useMemo } from "react";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/cn";
import { Tabs, TabsIndicator, TabsList, TabsTrigger, TABS_PILL_TRIGGER } from "@renderer/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { Kbd } from "@renderer/components/ui/kbd";
import { Activity, Bug, Folder, GitCompare, Hammer, StickyNote, Users, X, type IconComponent } from "../chrome/icons";
import { BuildPanel } from "../chrome/rail/BuildPanel";
import { ChangesPanel } from "../chrome/rail/ChangesPanel";
import { FileTree } from "../chrome/FileTree";
import { useDragResize } from "../hooks/useDragResize";
import { useSashKeys } from "../hooks/useSashKeys";
import { useGitFileStatuses } from "../hooks/useGitFileStatuses";
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
import { isMasterThread } from "../lib/masterThread";
import { projectForCwd } from "../lib/tcserver/projects";
import type { ProjectMeta, WorkspaceMeta } from "../lib/tcserver/types";
import { useProjects, useWorkspaces } from "../lib/tcserver/workspaces";
import { useAgents } from "../lib/threads/agents";
import { useActivity } from "../lib/activity";
import { ActivitySection } from "./threads/ActivitySection";
import { FleetList } from "./threads/fleet/FleetPanel";
import { NotesBody } from "./threads/NotesPanel";
import { SessionActionsContext } from "./threadChat";
import { LoadingLine } from "./SurfaceSkeleton";
import { shortcutFor } from "../lib/settings";

// The Debug section drives the editor chunk's DAP session; it loads with it.
const DebugPanel = lazy(() => import("../chrome/rail/DebugPanel"));
// Listed for a dev build, and for any thread that asked for it ("Debug this file").
const DEBUG_SECTION = import.meta.env.DEV;

/** A master's Agents section lists its own subagents; its batch is on the board. */
export const MASTER_AGENTS_EMPTY = "Batch threads are on the board";

/** Each section's segment glyph; its name is the segment's label and tooltip. */
const SECTION_ICON: Record<Section, IconComponent> = {
  activity: Activity,
  agents: Users,
  changes: GitCompare,
  notes: StickyNote,
  files: Folder,
  build: Hammer,
  debug: Bug,
};

/** The header's sections: flat 28px ghost icon buttons 2px apart, named by
 *  their aria-label and a tooltip, with no track; the selected one's fill is
 *  the pill, gliding between them on the layout spring. */
export function PanelSections({
  sections,
  value,
  onChange,
}: {
  sections: readonly Section[];
  value: Section;
  onChange: (section: Section) => void;
}) {
  return (
    <Tabs value={value} onValueChange={(next) => onChange(next as Section)} className="min-w-0 flex-1">
      <TabsList aria-label="Panel sections" data-slot="panel-sections" className="relative gap-0.5 bg-transparent p-0 group-data-[orientation=horizontal]/tabs:h-7">
        <TabsIndicator className="bg-foreground/7" />
        {sections.map((s) => {
          const Icon = SECTION_ICON[s];
          return (
            <Tooltip key={s}>
              <TooltipTrigger
                render={<TabsTrigger value={s} aria-label={SECTION_LABEL[s]} className={`size-7 flex-none rounded-lg p-0 not-data-active:hover:bg-foreground/5 ${TABS_PILL_TRIGGER}`} />}
              >
                <Icon className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent side="bottom">{SECTION_LABEL[s]}</TooltipContent>
            </Tooltip>
          );
        })}
      </TabsList>
    </Tabs>
  );
}

/** The panel's 40px header, the same height as the title bar's row above it, so the buttons sit with 6px of air between its line and the title bar's: the sections on the 12px inset and Hide at its end. */
export function PanelHeader({ sections, value, onChange, onClose }: { sections: readonly Section[]; value: Section; onChange: (section: Section) => void; onClose: () => void }) {
  return (
    <TooltipProvider>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-3">
        <PanelSections sections={sections} value={value} onChange={onChange} />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button variant="ghost" size="icon-sm" aria-label="Hide panel" className="text-muted-foreground hover:text-foreground" onClick={onClose} />
          }
        >
          <X className="size-3.5" />
        </TooltipTrigger>
        <TooltipContent>
          Hide panel <Kbd>{shortcutFor("App", "Panel")}</Kbd>
        </TooltipContent>
      </Tooltip>
      </div>
    </TooltipProvider>
  );
}

export type RightPanelProps = {
  /** The thread the sections draw: the one the pane shows. */
  session: Session;
  /** The tab whose panel this is (open, width, room); the session's own id by default. */
  paneId?: string;
  onOpenFile: OpenFileFn;
  onOpenDiff: (path?: string) => void;
  onOpenSession?: (sessionId: string) => void;
  /** The drawn width, fitted to the thread's row (ThreadView, `panelFit`); the stored width by default. */
  width?: number;
  /** The widest the row allows a drag to (the row less `THREAD_MIN`). */
  maxWidth?: number;
  /** The review file the focused tab shows, relative to the git root. */
  selectedPath?: string;
  /** How the pane moves (ThreadView): `arrive` slides it in from the row's right edge when it opens in place; `leave` keeps it drawn over the thread, inert, while it slides back out after a close. */
  motion?: PanelMotion;
  /** The leave's slide ended: ThreadView unmounts the pane. */
  onLeft?: () => void;
};

export type PanelMotion = "arrive" | "leave";

/** The pane's move on the tokens: in from the right edge over `--dur-slow`
 *  (a panel's entrance), out a quarter of its width and faded over
 *  `--dur-fast` (every exit), on transitions so a toggle mid-move turns back
 *  from where it is; opacity alone under reduced motion. Translate and
 *  opacity only: the thread column takes its width once, at the click, so no
 *  frame lays out the transcript. */
export const PANE_MOTION = "transition-[translate,opacity] duration-(--dur-slow) ease-(--ease-out) motion-reduce:transition-opacity";
export const PANE_ARRIVE = "starting:translate-x-full starting:opacity-0";
export const PANE_LEAVE =
  "pointer-events-none absolute inset-y-0 right-0 z-20 data-ending-style:translate-x-1/4 data-ending-style:opacity-0 data-ending-style:duration-(--dur-fast) data-ending-style:ease-(--ease-exit)";

/**
 * The one column at a root thread's right edge (docs/LAYOUT.md "The right
 * side"): a 40px header of the sections that exist for the thread's state
 * and a close button, the section's body under it. Opened in place it
 * slides in from the right edge and closed it slides back out over the
 * thread (PANE_MOTION); it never tweens its width, and a section's body
 * fades in over `--dur-fast`. Closed is closed: the thread header's button
 * and ⌘⇧R reopen it on its last section.
 */
export function RightPanel(props: RightPanelProps) {
  const { session } = props;
  const pane = props.paneId ?? session.id;
  // Open and width are the pane's; the section memory is the shown thread's (lib/rightPanel.ts).
  const state = useRightPanel(pane);
  const facts = usePanelFacts(session, state, pane !== session.id);
  const available = useMemo(() => sectionsFor(facts.facts), [facts.facts]);
  const section = shownSection(state.section, available);
  // The title bar's agents cue reads what is drawn, not what was asked for.
  const drawn = state.open && props.motion !== "leave" ? section : null;
  useEffect(() => rightPanel.setShown(pane, drawn), [pane, drawn]);
  useEffect(() => () => rightPanel.setShown(pane, null), [pane]);

  const resize = useDragResize({
    edge: "left",
    min: PANEL_MIN,
    max: () => Math.min(PANEL_MAX, props.maxWidth ?? Math.floor(window.innerWidth * 0.5)),
    defaultWidth: PANEL_WIDTH,
    initial: state.width,
    onCommit: (next) => rightPanel.setWidth(pane, next),
  });
  // Taken apart at once: the pane's ref callback goes to a `ref` prop, which
  // would make the React Compiler read the whole object as a ref.
  const { attachPane, dragging, onPointerDown, reset, resizeTo, width } = resize;
  const sashKeys = useSashKeys({
    label: "Resize panel",
    orientation: "vertical",
    // The drawn width: a fitted panel's keys step from what is on screen.
    value: props.width ?? width,
    min: PANEL_MIN,
    max: Math.min(PANEL_MAX, props.maxWidth ?? Math.floor(window.innerWidth * 0.5)),
    getSpan: (handle) => handle.parentElement?.parentElement?.getBoundingClientRect().width || window.innerWidth,
    direction: -1,
    onChange: resizeTo,
    onReset: reset,
  });

  const leaving = props.motion === "leave";
  if ((!state.open && !leaving) || !section) return null;

  return (
    <aside
      ref={attachPane}
      aria-label="Thread panel"
      data-ending-style={leaving ? "" : undefined}
      inert={leaving}
      onTransitionEnd={(e) => {
        if (leaving && e.target === e.currentTarget && e.propertyName === "opacity") props.onLeft?.();
      }}
      className={cn("relative flex shrink-0 flex-col border-l border-border bg-sidebar", PANE_MOTION, props.motion === "arrive" && PANE_ARRIVE, leaving && PANE_LEAVE)}
      style={{ width: props.width ?? state.width, contain: "strict" }}
    >
      <PanelHeader sections={available.sections} value={section} onChange={(next) => rightPanel.set(pane, { section: next })} onClose={() => rightPanel.close(pane)} />
      <div
        key={section}
        className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-(--dur-fast) flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        <SectionBody section={section} project={facts.project} workspace={facts.workspace} {...props} />
      </div>
      <div
        {...sashKeys}
        className={`absolute inset-y-0 -left-px z-10 w-1.5 cursor-col-resize touch-none outline-none focus-visible:bg-accent ${
          dragging ? "bg-foreground/12" : "hover:bg-foreground/7"
        }`}
        onPointerDown={onPointerDown}
      />
    </aside>
  );
}

type PanelPlace = { facts: PanelFacts; project: ProjectMeta | undefined; workspace: WorkspaceMeta | undefined };

/** The thread's state as the facts `sectionsFor` reads, and the project (or a loose chat's git workspace) the sections key by. `inPane`: another tab's pane shows the thread, so a subagent has a panel there. */
function usePanelFacts(session: Session, state: PanelState, inPane: boolean): PanelPlace {
  const agents = useAgents(session.id);
  const projects = useProjects();
  const workspaces = useWorkspaces();
  const project =
    (session.cwd && session.cwd !== "~" ? projectForCwd(session.cwd, projects) : undefined) ??
    projects.find((p) => p.id === session.projectId && p.environmentId === session.environmentId);
  const workspace = project?.cwd ? undefined : looseWorkspace(session, workspaces);
  const activity = useActivity(session.id).rows;
  const facts = useMemo<PanelFacts>(
    () => ({
      root: !session.parentId || inPane,
      notes: !session.parentId,
      project: !!session.projectId && !!project?.cwd,
      checkout: !!project?.cwd || !!workspace,
      agents: agents.length,
      // The rows A6 joins: background tasks, a batch, the thread's dev servers and Mac bridge calls.
      activity: activity.length,
      debug: DEBUG_SECTION || state.debug,
    }),
    [session, project, workspace, agents.length, activity.length, state.debug, inPane],
  );
  return { facts, project, workspace };
}

/** A loose chat's workspace when its folder is a git repository: by the thread's workspace id on its host, else by its cwd. */
function looseWorkspace(session: Session, workspaces: WorkspaceMeta[]): WorkspaceMeta | undefined {
  const onHost = workspaces.filter((w) => w.environmentId === session.environmentId);
  const workspace =
    (session.workspaceId ? onHost.find((w) => w.id === session.workspaceId) : undefined) ??
    (session.cwd ? onHost.find((w) => w.path === session.cwd) : undefined);
  return workspace?.git ? workspace : undefined;
}

function SectionBody({
  section,
  project,
  workspace,
  session,
  onOpenFile,
  onOpenDiff,
  onOpenSession,
  selectedPath,
}: RightPanelProps & { section: Section; project: ProjectMeta | undefined; workspace: WorkspaceMeta | undefined }) {
  const cwd = project?.cwd ?? workspace?.path ?? session.cwd;
  const gitStatuses = useGitFileStatuses(cwd, section === "files");
  const actions = useContext(SessionActionsContext);
  switch (section) {
    case "activity":
      return <ActivitySection threadId={session.id} />;
    case "agents":
      return (
        <FleetList
          sessionId={session.id}
          parentCwd={session.cwd}
          emptyLine={isMasterThread(session) ? MASTER_AGENTS_EMPTY : undefined}
          onOpenSession={onOpenSession}
          onOpenFile={onOpenFile}
          onOpenDiff={onOpenDiff}
        />
      );
    case "notes":
      return <NotesBody session={session} />;
    case "changes":
      return <ChangesPanel cwd={cwd} sessionId={session.id} busy={!!session.busy} selectedPath={selectedPath} onOpenDiff={onOpenDiff} onOpenFile={onOpenFile} />;
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
    case "debug":
      return (
        <Suspense fallback={<LoadingLine label="Loading the debugger" />}>
          <DebugPanel />
        </Suspense>
      );
  }
}
