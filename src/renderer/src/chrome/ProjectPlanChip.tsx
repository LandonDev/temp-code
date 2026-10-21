import { useRef, useState } from "react";
import { milestoneSummary } from "@server/shared/projectPlan";
import { usePlanFile } from "../hooks/usePlanFile";
import { useProjectPlan } from "../lib/projectPlan";
import { sessionStore } from "../lib/tcserver/store";
import { useProject } from "../stores/project";
import { ProjectPlanOptions } from "../surfaces/threads/ProjectPlanCard";
import { ChevronRight, Milestone } from "./icons";
import { Popover } from "./Popover";

/**
 * The project header's plan (docs/PROJECT-PLAN.md): while the selected
 * project has a project plan, a chip after the new-thread chooser — "Plan",
 * or "Plan · 3 of 7 milestones done" once it is kept as the project's plan.
 * It opens the plan, and its popover offers the plan's options.
 */
export function ProjectPlanChip() {
  const projectId = useProject((s) => s.selectedProjectId);
  const state = useProjectPlan(projectId);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  // The document only while the popover shows: the next milestone comes from it.
  const doc = usePlanFile(open && state?.exists ? state.path : null, false);
  if (!state || (!state.exists && !state.sessionId)) return null;
  const summary = state.pinned ? milestoneSummary(docOf(state)) : "Plan";
  const session = state.sessionId ? sessionStore.get(state.sessionId) : undefined;
  const openPlan = (): void => {
    setOpen(false);
    if (state.sessionId) sessionStore.requestOpen(state.sessionId);
  };
  return (
    <>
      <button
        ref={trigger}
        type="button"
        title={state.pinned ? "The project's plan" : "The project plan"}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-tauri-drag-region="false"
        onClick={() => setOpen((o) => !o)}
        className={`flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] tabular-nums text-content/50 hover:bg-content/5 hover:text-content ${
          open ? "bg-content/10 text-content" : ""
        }`}
      >
        <Milestone className="size-3.5 text-violet" strokeWidth={1.75} />
        <span>{summary}</span>
      </button>
      {open ? (
        <Popover
          anchor={trigger}
          side="bottom"
          align="start"
          width={320}
          role="dialog"
          aria-label="Project plan"
          onDismiss={() => setOpen(false)}
          ignore="[data-project-plan-chip]"
        >
          <button
            type="button"
            onClick={openPlan}
            className="group/act flex w-full items-center gap-2 border-b border-content/10 px-3 py-2 text-left hover:bg-content/5"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium">Open the plan</span>
              <span className="block text-xs text-content/50">{summary}</span>
            </span>
            <ChevronRight className="size-3.5 text-content/40 group-hover/act:text-content" strokeWidth={1.75} />
          </button>
          {session && doc ? (
            <ProjectPlanOptions
              session={session}
              doc={doc}
              state={state}
              compact
              onStarted={(id) => {
                setOpen(false);
                sessionStore.requestOpen(id);
              }}
              onChanged={() => setOpen(false)}
            />
          ) : null}
        </Popover>
      ) : null}
    </>
  );
}

/** The summary needs only the ticks, which the state carries without the file. */
function docOf(state: { milestones: { index: number; title: string; done: boolean }[] }): string {
  return `## Milestones\n${state.milestones.map((m) => `### [${m.done ? "x" : " "}] ${m.index}. ${m.title}`).join("\n")}\n`;
}
