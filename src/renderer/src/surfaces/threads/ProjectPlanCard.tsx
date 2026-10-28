import { useState } from "react";
import type { ProjectPlanState } from "@server/shared/contract-projectplan";
import { nextMilestone, parseProjectPlan, type Milestone } from "@server/shared/projectPlan";
import { Pin } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Item, ItemButton, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "../../components/ui/item";
import { Spinner } from "../../components/ui/spinner";
import { Toggle } from "../../components/ui/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import {
  pinProjectPlan,
  reviseProjectPlan,
  startMilestoneOrchestration,
  startMilestonePlanning,
  tickMilestone,
} from "../../lib/projectPlan";
import type { Session } from "../../lib/session";
import { RevisePlanDialog } from "./RevisePlanDialog";
import type { OpenFileFn } from "../../lib/search";
import { AgentMarkdown } from "../AgentMarkdown";

/**
 * The project plan's live pieces (docs/PROJECT-PLAN.md): the milestone
 * list with its ticks, the buttons a complete plan ends with, and the pin
 * the view's header carries. The project header's plan chip lists the
 * same actions as rows.
 */

/** The ## Milestones section as rows: a tick (by hand here; the landed
 *  build ticks on its own), the title, and its fields. */
export function MilestoneList({
  doc,
  projectId,
  onTicked,
  cwd,
  onOpenFile,
}: {
  doc: string;
  projectId: string | null | undefined;
  onTicked?: () => void;
  /** Where a scope's file links resolve and open, as the plan's own text does. */
  cwd?: string;
  onOpenFile?: OpenFileFn;
}) {
  const { milestones } = parseProjectPlan(doc);
  const [busy, setBusy] = useState<number | null>(null);
  if (milestones.length === 0) return null;
  const tick = async (m: Milestone, done: boolean): Promise<void> => {
    if (!projectId || busy !== null) return;
    setBusy(m.index);
    try {
      await tickMilestone(projectId, m.index, done);
      onTicked?.();
    } finally {
      setBusy(null);
    }
  };
  return (
    <ItemGroup aria-label="Milestones" className="-mx-2.5 my-2 gap-1">
      {milestones.map((m) => (
        <Item key={m.index} size="sm" role="listitem">
          <ItemMedia>
            <Checkbox
              checked={m.done}
              disabled={!projectId || busy === m.index}
              onCheckedChange={(checked) => void tick(m, checked)}
              aria-label={`Milestone ${m.index}: ${m.title}`}
            />
          </ItemMedia>
          <ItemContent>
            <ItemTitle className="text-sm font-normal">
              <span className="text-muted-foreground tabular-nums">{m.index}</span>
              <span className={m.done ? "text-muted-foreground" : "text-foreground"}>{m.title}</span>
            </ItemTitle>
            {m.scope ? (
              // Scope is markdown (`code`, links): the app's own renderer, at the description's size and ink.
              <ItemDescription className="line-clamp-none [&_.agent-markdown]:text-xs [&_.agent-markdown]:leading-normal" data-milestone-scope>
                <AgentMarkdown text={m.scope} size="compact" className="agent-reasoning" cwd={cwd} onOpenFile={onOpenFile} />
              </ItemDescription>
            ) : null}
            {m.dependencies ? (
              <ItemDescription className="line-clamp-none">
                <span className="font-medium">Depends on</span> {m.dependencies}
              </ItemDescription>
            ) : null}
            {m.doneWhen ? (
              <ItemDescription className="line-clamp-none">
                <span className="font-medium">Done when</span> {m.doneWhen}
              </ItemDescription>
            ) : null}
          </ItemContent>
        </Item>
      ))}
    </ItemGroup>
  );
}

/** The header's pin: keeps the plan as the project's, ticked as builds land. */
export function ProjectPlanPin({
  projectId,
  pinned,
  onChanged,
}: {
  projectId: string | null | undefined;
  pinned: boolean;
  onChanged?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const flip = async (next: boolean): Promise<void> => {
    if (!projectId || busy) return;
    setBusy(true);
    try {
      await pinProjectPlan(projectId, next);
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            size="sm"
            pressed={pinned}
            disabled={!projectId || busy}
            onPressedChange={(next) => void flip(next)}
          />
        }
      >
        <Pin />
        Project's plan
      </TooltipTrigger>
      <TooltipContent>Keep as the project's plan</TooltipContent>
    </Tooltip>
  );
}

type Busy = "plan" | "orchestrate" | "revise" | "pin" | null;

/** What a finished project plan offers. `state` is the server's view (the
 *  pin); `doc` is the file as last polled, for the next milestone. */
export function ProjectPlanOptions({
  session,
  doc,
  state,
  onStarted,
  onChanged,
  compact = false,
}: {
  session: Session;
  doc: string;
  state: ProjectPlanState | null | undefined;
  /** A thread was started: open it. */
  onStarted?: (sessionId: string) => void;
  /** The plan's state changed (pin, revision turn sent). */
  onChanged?: () => void;
  /** In the header chip's popover: rows, with the pin among them. */
  compact?: boolean;
}) {
  const [busy, setBusy] = useState<Busy>(null);
  const [revising, setRevising] = useState(false);
  const next = nextMilestone(doc);
  const pinned = state?.pinned ?? false;
  const projectId = session.projectId ?? null;
  const run = async (what: Exclude<Busy, null>, fn: () => Promise<void>): Promise<void> => {
    if (busy) return;
    setBusy(what);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };
  const plan = () =>
    void run("plan", async () => {
      const t = await startMilestonePlanning(session, next!);
      onStarted?.(t.id);
    });
  const orchestrate = () =>
    void run("orchestrate", async () => {
      const t = await startMilestoneOrchestration(session, next!);
      onStarted?.(t.id);
    });

  if (compact) {
    const rows: { key: Exclude<Busy, null>; label: string; disabled: boolean; onClick: () => void }[] = [
      { key: "plan", label: next ? `Plan milestone ${next.index}` : "Plan the next milestone", disabled: !next, onClick: plan },
      {
        key: "orchestrate",
        label: next ? `Orchestrate milestone ${next.index}` : "Orchestrate the next milestone",
        disabled: !next,
        onClick: orchestrate,
      },
      {
        key: "revise",
        label: "Revise the plan",
        disabled: false,
        onClick: () =>
          void run("revise", async () => {
            await reviseProjectPlan(session, "");
            onChanged?.();
          }),
      },
      {
        key: "pin",
        label: pinned ? "Stop keeping as the project's plan" : "Keep as the project's plan",
        disabled: !projectId,
        onClick: () =>
          void run("pin", async () => {
            await pinProjectPlan(projectId!, !pinned);
            onChanged?.();
          }),
      },
    ];
    return (
      <ItemGroup className="p-1" data-project-plan-options>
        {rows.map((r) => (
          <ItemButton
            key={r.key}
            size="xs"
            disabled={r.disabled || busy !== null} onClick={r.onClick}
            className="text-left hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
          >
            <ItemContent>
              <ItemTitle className="font-normal">{r.label}</ItemTitle>
            </ItemContent>
            {busy === r.key ? <Spinner /> : null}
          </ItemButton>
        ))}
      </ItemGroup>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2" data-project-plan-options>
      {next ? (
        <>
          <Button disabled={busy !== null} onClick={plan}>
            {busy === "plan" ? <Spinner /> : `Plan milestone ${next.index}`}
          </Button>
          <Button variant="secondary" disabled={busy !== null} onClick={orchestrate}>
            {busy === "orchestrate" ? <Spinner /> : `Orchestrate milestone ${next.index}`}
          </Button>
        </>
      ) : (
        <span className="mr-2 text-[13px] text-muted-foreground">Every milestone is done</span>
      )}
      <Button variant="secondary" disabled={busy !== null} onClick={() => setRevising(true)}>
        Revise…
      </Button>
      <RevisePlanDialog
        open={revising}
        onOpenChange={setRevising}
        onSend={async (ask) => {
          await reviseProjectPlan(session, ask);
          onChanged?.();
        }}
      />
    </div>
  );
}

/** The buttons a complete project plan ends with. */
export function ProjectPlanCard(props: {
  session: Session;
  doc: string;
  state: ProjectPlanState | null | undefined;
  onStarted?: (sessionId: string) => void;
  onChanged?: () => void;
}) {
  return (
    <section aria-label="Project plan options" data-project-plan-card className="mt-6">
      <ProjectPlanOptions {...props} />
    </section>
  );
}
