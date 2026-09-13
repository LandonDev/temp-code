import { lazy, memo, Suspense } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useGitFileStatuses } from "../../hooks/useGitFileStatuses";
import { EASE_DRAWER } from "../../lib/ease";
import { useEditorState } from "../../lib/monaco/editorState";
import { useBuild } from "../../lib/projectRailStore";
import { setRailPanel, useRailPanel, type RailPanel } from "../../lib/railPanel";
import { useRightRailOpen } from "../../lib/rightRail";
import { projectForCwd } from "../../lib/tcserver/projects";
import { useProjects } from "../../lib/tcserver/workspaces";
import { useProject } from "../../stores/project";
import { cn } from "../../motion/cn";
import { FileTree } from "../FileTree";
import { Spinner } from "../../surfaces/threads/bits";
import { BranchPanel } from "./BranchPanel";
import { BuildPanel } from "./BuildPanel";
import { ChangesPanel } from "./ChangesPanel";

// The Debug tab drives the editor chunk's DAP session; it loads with it.
const DebugPanel = lazy(() => import("./DebugPanel"));

/**
 * The project's right rail: a 288px drawer at the main grid boundary, right
 * of the pane tree and the diff pane. Files reuses the sidebar's tree;
 * Changes, Branch, Build and Debug are temp-code's. Everything inside is
 * keyed by the project the current cwd resolves to, never a global selection.
 */

const WIDTH = 288;
const TABS: { id: RailPanel; label: string }[] = [
  { id: "changes", label: "Changes" },
  { id: "files", label: "Files" },
  { id: "branch", label: "Branch" },
  { id: "build", label: "Build" },
  { id: "debug", label: "Debug" },
];

type Props = {
  cwd: string;
  onOpenFile: (path: string) => void;
  onOpenDiff: (path: string) => void;
};

/** Memoized: a thread switch re-renders App, but the rail's props stay put within a project. */
export const ProjectRail = memo(function ProjectRail({ cwd, onOpenFile, onOpenDiff }: Props) {
  const open = useRightRailOpen();
  const projectId = useProject((s) => s.selectedProjectId);
  const reduce = useReducedMotion();
  const projects = useProjects();
  const project =
    (cwd && cwd !== "~" ? projectForCwd(cwd, projects) : undefined) ??
    projects.find((p) => p.id === projectId);
  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.aside
          key="rail"
          initial={reduce ? false : { width: 0, opacity: 0 }}
          animate={{ width: WIDTH, opacity: 1 }}
          exit={reduce ? { width: 0 } : { width: 0, opacity: 0 }}
          transition={{ duration: 0.32, ease: EASE_DRAWER }}
          className="flex h-full shrink-0 flex-col overflow-hidden border-l border-content/10 bg-background-base"
          aria-label="Project rail"
        >
          <div style={{ width: WIDTH }} className="flex h-full min-h-0 flex-col">
            {project ? (
              <RailBody
                key={project.id}
                projectId={project.id}
                cwd={project.cwd}
                onOpenFile={onOpenFile}
                onOpenDiff={onOpenDiff}
              />
            ) : (
              <p className="px-3 py-3 text-[12px] text-content/50">No project</p>
            )}
          </div>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
});

function RailBody({ projectId, cwd, onOpenFile, onOpenDiff }: Props & { projectId: string }) {
  const panel = useRailPanel();
  const gitStatuses = useGitFileStatuses(cwd, panel === "files");
  const building = useBuild(projectId)?.run?.status === "running";
  const debugPhase = useEditorState((s) => s.debugPhase);
  return (
    <>
      <div
        data-tauri-drag-region
        className="flex h-11 shrink-0 items-center gap-0.5 border-b border-content/10 px-2"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={panel === t.id}
            onClick={() => setRailPanel(t.id)}
            className={cn(
              "flex h-6 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors",
              panel === t.id
                ? "bg-content/8 text-content"
                : "text-content/50 hover:bg-content/5 hover:text-content/80",
            )}
          >
            {t.label}
            {t.id === "build" && building ? (
              <span className="size-1.5 animate-pulse rounded-full bg-success" aria-label="Building" />
            ) : null}
            {t.id === "debug" && debugPhase !== "idle" ? (
              <span
                className={cn("size-1.5 rounded-full", debugPhase === "stopped" ? "bg-warning" : "animate-pulse bg-busy")}
                aria-label={debugPhase}
              />
            ) : null}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {panel === "changes" ? (
          <ChangesPanel cwd={cwd} onOpenDiff={onOpenDiff} />
        ) : null}
        {panel === "files" ? (
          <FileTree key={cwd} cwd={cwd} onOpenFile={onOpenFile} gitStatuses={gitStatuses} />
        ) : null}
        {panel === "branch" ? <BranchPanel projectId={projectId} onOpenDiff={onOpenDiff} /> : null}
        {panel === "build" ? <BuildPanel projectId={projectId} /> : null}
        {panel === "debug" ? (
          <Suspense
            fallback={
              <div className="flex h-16 items-center justify-center">
                <Spinner className="size-3.5 text-content/50" />
              </div>
            }
          >
            <DebugPanel />
          </Suspense>
        ) : null}
      </div>
    </>
  );
}
