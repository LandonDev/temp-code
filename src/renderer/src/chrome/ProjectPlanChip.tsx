import { useState } from "react";
import type { ProjectPlanState } from "@server/shared/contract-projectplan";
import { Button } from "../components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { usePlanFile } from "../hooks/usePlanFile";
import { useProjectPlan } from "../lib/projectPlan";
import { sessionStore } from "../lib/tcserver/store";
import { useProject } from "../stores/project";
import { ProjectPlanOptions } from "../surfaces/threads/ProjectPlanCard";
import { Milestone } from "./icons";

/** The chip's words: "Plan", and the milestones done of all of them once
 *  the plan is kept as the project's plan. */
export function planChipLabel(state: Pick<ProjectPlanState, "pinned" | "milestones">): { label: string; tally: string | null } {
  if (!state.pinned || state.milestones.length === 0) return { label: "Plan", tally: null };
  const done = state.milestones.filter((m) => m.done).length;
  return { label: "Plan", tally: `${done}/${state.milestones.length}` };
}

/**
 * The project header's plan (docs/PROJECT-PLAN.md): while the selected
 * project has a project plan, a chip after the new-thread chooser, "Plan",
 * with its milestones' tally once it is kept as the project's plan. Its
 * popover opens the plan and offers the plan's options.
 */
export function ProjectPlanChip() {
  const projectId = useProject((s) => s.selectedProjectId);
  const state = useProjectPlan(projectId);
  const [open, setOpen] = useState(false);
  // The document only while the popover shows: the next milestone comes from it.
  const doc = usePlanFile(open && state?.exists ? state.path : null, false);
  if (!state || (!state.exists && !state.sessionId)) return null;
  const { label, tally } = planChipLabel(state);
  const session = state.sessionId ? sessionStore.get(state.sessionId) : undefined;
  const openPlan = (): void => {
    setOpen(false);
    if (state.sessionId) sessionStore.requestOpen(state.sessionId);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  data-tauri-drag-region="false"
                  className="gap-1.5 font-normal text-muted-foreground hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground"
                />
              }
            />
          }
        >
          <Milestone className="size-3.5 text-muted-foreground" strokeWidth={1.5} />
          <span>{label}</span>
          {tally ? <span className="tabular-nums text-muted-foreground">{tally}</span> : null}
        </TooltipTrigger>
        <TooltipContent side="bottom">{state.pinned ? "The project's plan" : "The project plan"}</TooltipContent>
      </Tooltip>
      <PopoverContent side="bottom" align="start" aria-label="Project plan" className="w-80 gap-0 p-1">
        <Button variant="ghost" size="sm" onClick={openPlan} className="h-8 w-full justify-start font-normal">
          Open the plan
        </Button>
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
      </PopoverContent>
    </Popover>
  );
}
