// A9 (notices): every typed notice row, through one switch.
import type { Block } from "../../lib/session";
import { errorRowOf, isErrorBlock } from "../../lib/turnOutcome";
import { passActionsOf } from "../../lib/turnClock";
import { useSessionMeta } from "../../lib/tcserver/store";
import type { OpenFileFn } from "../../lib/search";
import { ErrorChip } from "../ErrorChip";
import { CompactionCard } from "../CompactionCard";
import { AgentSpawnRow, PlanHandoffRow } from "../AgentSpawnRow";
import { GateCard } from "../GateCard";
import { ReviewCard } from "../ReviewCard";
import { useTurnState } from "../turnState";
import { useTranscriptSession } from "../transcriptSession";

/** A system row the host typed: compaction, a spawned agent, a plan handoff,
 *  a review, a gate, an error or a turn pass. */
export function isNoticeBlock(block: Block): boolean {
  return !!(
    block.compaction ||
    block.agent ||
    block.planHandoff ||
    block.review ||
    block.gate ||
    isErrorBlock(block) ||
    passActionsOf(block)
  );
}

/** The one switch over typed notice rows; null for a block that is none. */
export function NoticeRow({
  block,
  cwd,
  onOpenFile,
}: {
  block: Block;
  cwd?: string;
  onOpenFile?: OpenFileFn;
}) {
  if (block.compaction) return <CompactionCard block={block} />;
  if (block.agent) return <AgentSpawnRow block={block} />;
  if (block.planHandoff) return <PlanHandoffRow block={block} />;
  if (block.review) return <ReviewCard block={block} cwd={cwd} onOpenFile={onOpenFile} />;
  if (block.gate) return <GateCard block={block} />;
  if (isErrorBlock(block)) return <ErrorRowView block={block} />;
  const actions = passActionsOf(block);
  if (actions) return <PassRow actions={actions} />;
  return null;
}

/** A driver error row: gray Stopped, or Failed with Continue when the tree can. */
export function ErrorRowView({ block }: { block: Block }) {
  const session = useTurnState();
  const sessionId = useTranscriptSession();
  // The tree's continue flag lives on the meta until the projection carries it.
  const meta = useSessionMeta(sessionId);
  const row = errorRowOf(
    session
      ? { ...session, treeCanContinue: session.treeCanContinue ?? meta?.treeCanContinue }
      : { blocks: [block], status: "idle", thread: undefined },
    block,
  );
  if (!sessionId) return null;
  return (
    <div className="py-1">
      <ErrorChip sessionId={sessionId} row={row} busy={session?.busy} />
    </div>
  );
}

/** What the turn-pass did between turns: a compact line, not a system dump. */
export function PassRow({ actions }: { actions: string[] }) {
  return (
    <div className="flex items-center gap-2 py-1 font-sans text-[12px] text-content/40">
      <span className="text-content/40">Pass</span>
      <span className="min-w-0 truncate">{actions.join(" · ")}</span>
    </div>
  );
}
