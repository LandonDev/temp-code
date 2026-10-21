import { useEffect } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { MilestoneLink, ProjectPlanState } from "@server/shared/contract-projectplan";
import {
  milestoneOrchestrationBrief,
  milestonePlanningBrief,
  milestoneThreadTitle,
  type Milestone,
} from "@server/shared/projectPlan";
import { nativeModelId } from "./models";
import { sessionDisplayTitle, type Session } from "./session";
import { policyForMode } from "./tcserver/access";
import { send, startThread } from "./tcserver/commands";
import { linkOfProject } from "./tcserver/projects";
import { sessionStore } from "./tcserver/store";
import type { SessionMeta } from "./tcserver/types";

/**
 * The project plan's state per project (docs/PROJECT-PLAN.md): pinned or
 * not, the thread that wrote it, its milestones and their ticks, as the
 * server last answered `projectPlan.get`. The document itself is polled by
 * the plan view (usePlanFile); this store carries what the project header
 * and the options card need without the file. Reloaded after every action
 * here, after a merge lands (projectRailStore.mergeInto) and whenever a
 * project-plan thread of the project settles.
 */

type State = {
  /** by project id; null = asked and the project has no plan */
  plans: Record<string, ProjectPlanState | null>;
};

const store = createStore<State>(() => ({ plans: {} }));
export const projectPlanStore = store;

const inflight = new Map<string, Promise<void>>();

export function loadProjectPlan(projectId: string): Promise<void> {
  const pending = inflight.get(projectId);
  if (pending) return pending;
  const p = (async () => {
    try {
      const state = await linkOfProject(projectId).request<ProjectPlanState | null>("projectPlan.get", { projectId });
      store.setState((s) => ({ plans: { ...s.plans, [projectId]: state } }));
    } catch {
      // An older host without project plans: nothing to show.
    } finally {
      inflight.delete(projectId);
    }
  })();
  inflight.set(projectId, p);
  return p;
}

/** The plan state of a project, loaded on first ask and refreshed when one
 *  of its project-plan threads settles. `undefined` until the first answer. */
export function useProjectPlan(projectId: string | null | undefined): ProjectPlanState | null | undefined {
  const state = useStore(store, (s) => (projectId ? s.plans[projectId] : null));
  useEffect(() => {
    if (!projectId) return;
    if (store.getState().plans[projectId] === undefined) void loadProjectPlan(projectId);
    // A project-plan thread of this project going idle (plan_complete
    // lands at the end of its turn) refreshes the state.
    const seen = new Map<string, string>();
    return sessionStore.onMetaChange(() => {
      for (const m of sessionStore.metas()) {
        if (m.projectId !== projectId || m.threadType !== "project-plan") continue;
        const prev = seen.get(m.id);
        seen.set(m.id, m.status);
        if (prev !== undefined && prev !== m.status && m.status === "idle") void loadProjectPlan(projectId);
      }
    });
  }, [projectId]);
  return state;
}

export async function pinProjectPlan(projectId: string, pinned: boolean): Promise<void> {
  const state = await linkOfProject(projectId).request<ProjectPlanState | null>("projectPlan.pin", { projectId, pinned });
  store.setState((s) => ({ plans: { ...s.plans, [projectId]: state } }));
}

export async function tickMilestone(projectId: string, milestone: number, done: boolean): Promise<void> {
  const out = await linkOfProject(projectId).request<{ ticked: boolean; state: ProjectPlanState | null }>(
    "projectPlan.tick",
    { projectId, milestone, done },
  );
  store.setState((s) => ({ plans: { ...s.plans, [projectId]: out.state } }));
}

export function linkMilestone(sessionId: string, link: MilestoneLink): Promise<void> {
  return linkOfProject(link.projectId).request<void>("projectPlan.link", { sessionId, ...link });
}

/** The build knobs a thread started from the plan inherits from the plan thread. */
function inherited(plan: Session) {
  return {
    environmentId: plan.environmentId,
    provider: plan.harness,
    model: nativeModelId(plan.model),
    reasoning: plan.modelSettings.effort,
    context1m: plan.modelSettings.context === "1m",
    permission: policyForMode(plan.runtimeMode),
    projectId: plan.projectId ?? null,
    workspaceId: plan.workspaceId ?? null,
    cwd: plan.cwd,
  };
}

/** "Plan the next milestone": a planning thread for one milestone, linked
 *  to it so the build started from that plan ticks it when it lands. It
 *  then flows through the ordinary single-build path. */
export async function startMilestonePlanning(plan: Session, milestone: Milestone): Promise<SessionMeta> {
  if (!plan.planPath || !plan.projectId) throw new Error("the project plan has no file or project");
  const thread = await startThread(
    { ...inherited(plan), threadType: "planning", title: milestoneThreadTitle(milestone) },
    milestonePlanningBrief(plan.planPath, milestone),
  );
  await linkMilestone(thread.id, { projectId: plan.projectId, milestone: milestone.index });
  return thread;
}

/** "Start an orchestration thread for milestone N": the orchestrator works
 *  the milestone straight from the project plan. */
export async function startMilestoneOrchestration(plan: Session, milestone: Milestone): Promise<SessionMeta> {
  if (!plan.planPath || !plan.projectId) throw new Error("the project plan has no file or project");
  const thread = await startThread(
    {
      ...inherited(plan),
      threadType: "orchestration",
      planPath: plan.planPath,
      title: milestoneThreadTitle(milestone),
      goal: milestone.doneWhen ?? undefined,
    },
    milestoneOrchestrationBrief(plan.planPath, milestone),
  );
  await linkMilestone(thread.id, { projectId: plan.projectId, milestone: milestone.index });
  return thread;
}

export const REVISE_DEFAULT =
  "Revise the project plan: re-read the project and the milestone ticks, bring Current state up to date, adjust the remaining milestones, and call plan_complete again when the revision is settled.";

/** "Revise the plan": a new turn in the project-plan thread. */
export function reviseProjectPlan(plan: Session, ask: string): Promise<void> {
  const text = ask.trim() ? `Revise the project plan: ${ask.trim()}\n\nKeep the milestone ticks that are there, edit the document in place, and call plan_complete again when the revision is settled.` : REVISE_DEFAULT;
  sessionStore.requestOpen(plan.id);
  return send(plan, text);
}

/** The plan's own title, for a thread title or a chip. */
export const projectPlanTitle = (plan: Session): string =>
  sessionDisplayTitle(plan.title, plan.harness).replace(/^Project plan:?\s*/i, "");
