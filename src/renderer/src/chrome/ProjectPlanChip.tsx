import { useState } from "react";
import type { ProjectPlanState } from "@server/shared/contract-projectplan";
import { ROW_CONTROL } from "./composerRow";
import { Button } from "../components/ui/button";
import { MENU_ROW } from "../components/ui/menu-row";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/lazy-menus";
import { usePlanFile } from "../hooks/usePlanFile";
import { useProjectPlan } from "../lib/projectPlan";
import { sessionStore } from "../lib/tcserver/store";
import { useProject } from "../stores/project";
import { dialogsChunk } from "../surfaces/chunks";
import { Maximize2, Milestone } from "./icons";

/** The plan's options ride the dialogs chunk, mounted only while the popover is open (surfaces/threads/ProjectPlanCard.tsx). */
const ProjectPlanOptions = dialogsChunk.surface("ProjectPlanOptions");

/** The chip's words: "Plan", and the milestones done of all of them once
 *  the plan is kept as the project's plan. */
export function planChipLabel(state: Pick<ProjectPlanState, "pinned" | "milestones">): { label: string; tally: string | null } {
  if (!state.pinned || state.milestones.length === 0) return { label: "Plan", tally: null };
  const done = state.milestones.filter((m) => m.done).length;
  return { label: "Plan", tally: `${done}/${state.milestones.length}` };
}

/**
 * The project's plan in the title bar (docs/PROJECT-PLAN.md): while the
 * selected project has a project plan, a chip leading the end group, "Plan",
 * with its milestones' tally once it is kept as the project's plan. Its words
 * say what it is, so it has no tooltip. Its popover opens the plan and offers
 * the plan's options.
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
      {/* The glyph follows the word's ink (currentColor), muted at rest and
          foreground on hover; the tally stays muted. */}
      <PopoverTrigger
        render={
          // The agents cue's size beside it: the quiet 24px row control.
          <Button
            variant="ghost"
            size="xs"
            data-tauri-drag-region="false"
            className={`${ROW_CONTROL} gap-2`}
            {...dialogsChunk.intent}
          />
        }
      >
        <Milestone className="size-3.5" />
        {/* 8px from the glyph, the tally 4px after the word (DESIGN "Typography"). */}
        <span className="flex items-baseline gap-1">
          <span>{label}</span>
          {tally ? <span className="tabular-nums text-muted-foreground">{tally}</span> : null}
        </span>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" aria-label="Project plan" className="w-80 gap-0 p-1">
        <Button variant="ghost" size="sm" onClick={openPlan} className={`${MENU_ROW} h-7 w-full justify-start rounded-lg font-normal`} data-plan-open>
          <Maximize2 />
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
