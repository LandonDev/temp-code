import { lazy, memo, Suspense } from "react";
import { motion, useReducedMotion } from "motion/react";
import { useGitFileStatuses } from "../../hooks/useGitFileStatuses";
import { EASE_OUT } from "../../lib/ease";
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
  /** the review file the focused tab shows, relative to the git root */
  selectedPath?: string;
  onOpenFile: (path: string) => void;
  onOpenDiff: (path: string) => void;
};

/** Memoized: a thread switch re-renders App, but the rail's props stay put within a project. */
export const ProjectRail = memo(function ProjectRail({ cwd, selectedPath, onOpenFile, onOpenDiff }: Props) {
  const open = useRightRailOpen();
  const projectId = useProject((s) => s.selectedProjectId);
  const reduce = useReducedMotion();
  const projects = useProjects();
  const project =
    (cwd && cwd !== "~" ? projectForCwd(cwd, projects) : undefined) ??
    projects.find((p) => p.id === projectId);
  if (!open) return null;
  // The drawer opens at full width at once; only its content fades in, and
  // nothing animates on close (the width tween re-laid out the pane tree
  // every frame).
  return (
    <aside
      style={{ width: WIDTH }}
      className="flex h-full shrink-0 flex-col overflow-hidden border-l border-content/10 bg-background-base"
      aria-label="Project rail"
    >
      <motion.div
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.12, ease: EASE_OUT }}
        className="flex h-full min-h-0 flex-col"
      >
        {project ? (
          <RailBody
            key={project.id}
            projectId={project.id}
            cwd={project.cwd}
            selectedPath={selectedPath}
            onOpenFile={onOpenFile}
            onOpenDiff={onOpenDiff}
          />
        ) : (
          <p className="px-3 py-2 text-[12px] text-content/50">No project</p>
        )}
      </motion.div>
    </aside>
  );
});

function RailBody({ projectId, cwd, selectedPath, onOpenFile, onOpenDiff }: Props & { projectId: string }) {
  const panel = useRailPanel();
  const gitStatuses = useGitFileStatuses(cwd, panel === "files");
  const building = useBuild(projectId)?.run?.status === "running";
  const debugPhase = useEditorState((s) => s.debugPhase);
  return (
    <>
      <div
        data-tauri-drag-region
        className="flex h-9 shrink-0 items-center gap-px border-b border-content/10 px-2"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={panel === t.id}
            onClick={() => setRailPanel(t.id)}
            className={cn(
              "pressable flex h-6 items-center gap-1.5 rounded-md px-2 text-[12px]",
              panel === t.id
                ? "bg-content/10 text-content"
                : "text-content/50 hover:bg-content/5 hover:text-content",
            )}
          >
            {t.label}
            {t.id === "build" && building ? (
              <span className="size-1.5 motion-safe:animate-pulse rounded-full bg-success" aria-label="Building" />
            ) : null}
            {t.id === "debug" && debugPhase !== "idle" ? (
              <span
                className={cn("size-1.5 rounded-full", debugPhase === "stopped" ? "bg-warning" : "motion-safe:animate-pulse bg-busy")}
                aria-label={debugPhase}
              />
            ) : null}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {panel === "changes" ? (
          <ChangesPanel cwd={cwd} selectedPath={selectedPath} onOpenDiff={onOpenDiff} />
        ) : null}
        {panel === "files" ? (
          <FileTree key={cwd} cwd={cwd} onOpenFile={onOpenFile} gitStatuses={gitStatuses} />
        ) : null}
        {panel === "branch" ? (
          <BranchPanel projectId={projectId} selectedPath={selectedPath} onOpenDiff={onOpenDiff} />
        ) : null}
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
