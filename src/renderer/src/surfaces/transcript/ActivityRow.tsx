// A8 (action rows): one action row in a group.
import { type Block } from "../../lib/session";
import type { OpenFileFn } from "../../lib/search";
import { EditRow } from "../EditRow";
import { splitEditCards } from "../editCards";
import { isEditBlock } from "../editModel";
import { isBatchSpawn, isFoldedStep, isThinkingBlock } from "../transcriptActivity";
import { isWaitCall, waitOutcomes } from "../agentSteps";
import { AgentStepRow, SpawnChildRow } from "../AgentSpawnRow";
import { inputOf } from "../../lib/toolDetails";
import { StatusMark, type ThreadState } from "../../components/ui/status";
import { ActionLine } from "./ActionLine";
import { NoticeLine } from "./NoticeLine";
import { StepRowContext } from "./stepLine";
import { SystemRow } from "./SystemRow";
import { ActivityThinkingRow } from "./ThinkingRow";
import { ApprovalCard } from "./ApprovalCard";
import { ActionRow } from "./ActionRow";
import type { ApprovalHandler } from "./types";

/**
 * One step of the agent's work, a tool call, a thought or a step the host
 * wrote (a report, a gate, a finished task): each file an edit changed as
 * its own edit row, each child a batch spawn made and each agent a wait
 * returned on as its own agent row, any other call as one action row, a
 * host step as the line it draws on its own. Every row looks the same wherever the group
 * puts it.
 */
export function ActivityRow({
  block,
  cwd,
  expanded = false,
  onApproval,
  onOpenFile,
  onOpenDiff,
}: {
  block: Block;
  cwd?: string;
  expanded?: boolean;
  /** The turn is live; a row speaks in its own call's tense either way. */
  live?: boolean;
  onApproval?: ApprovalHandler;
  onOpenFile?: OpenFileFn;
  onOpenDiff?: (path: string) => void;
}) {
  if (isFoldedStep(block)) {
    if (block.task) return <TaskStepRow task={block.task} />;
    // A host step reads verb then target, as a call does (stepLine.ts).
    return (
      <StepRowContext.Provider value>
        {block.backgroundCheck ? (
          <NoticeLine lead="Checked background tasks" />
        ) : (
          <SystemRow block={block} cwd={cwd} onOpenFile={onOpenFile} />
        )}
      </StepRowContext.Provider>
    );
  }
  if (isThinkingBlock(block)) {
    return (
      <ActivityThinkingRow block={block} cwd={cwd} expandable={expanded} onOpenFile={onOpenFile} />
    );
  }
  // An edit, waiting or not, is one row per file; one approval card under them all.
  if (isEditBlock(block) && !block.question) {
    const { cards, internal } = splitEditCards(block);
    return (
      <>
        {cards.map((card) => (
          <EditRow key={card.id} block={card} cwd={cwd} onOpenFile={onOpenDiff ?? onOpenFile} />
        ))}
        {internal ? <ActionRow block={internal} cwd={cwd} onOpenFile={onOpenFile} approval={false} /> : null}
        <ApprovalCard block={block} onApproval={onApproval} />
      </>
    );
  }
  // A wait is no row of its own: each agent it returned on is a step.
  if (isWaitCall(block)) {
    return (
      <div data-block={block.id} className="flex min-w-0 flex-col">
        {waitOutcomes(block).map((o) => (
          <AgentStepRow key={o.id} id={o.id} status={o.status} />
        ))}
      </div>
    );
  }
  // A batch spawn is one row per child once the host stamped them, as an edit is one row per file.
  const spawned = block.tool?.spawned ?? [];
  if (isBatchSpawn(block) && spawned.length > 0 && !block.approval) {
    const input = inputOf(block);
    const entries = Array.isArray(input.agents) ? (input.agents as { title?: unknown; task?: unknown }[]) : [];
    const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
    return (
      <div data-block={block.id} className="flex min-w-0 flex-col">
        {spawned.map((id, i) => (
          <SpawnChildRow key={id} id={id} inputTitle={str(entries[i]?.title)} task={str(entries[i]?.task) ?? str(input.task)} />
        ))}
      </div>
    );
  }
  return <ActionRow block={block} cwd={cwd} onApproval={onApproval} onOpenFile={onOpenFile} />;
}

const TASK_STEP: Record<NonNullable<Block["task"]>["status"], { state: ThreadState; verb: string }> = {
  completed: { state: "done", verb: "Task finished" },
  failed: { state: "failed", verb: "Task failed" },
  stopped: { state: "stopped", verb: "Task stopped" },
};

/** A background task that settled: its state's glyph, what happened, the model's label. Opens nothing. */
export function TaskStepRow({ task }: { task: NonNullable<Block["task"]> }) {
  const { state, verb } = TASK_STEP[task.status];
  return (
    <ActionLine
      glyph={<StatusMark state={state} word={false} />}
      verb={verb}
      object={task.label}
      title={task.label}
      label={`${verb} ${task.label}`}
    />
  );
}
