// A9 (notices): every typed notice row, through one switch.
import type { Block } from "../../lib/session";
import { errorRowOf, isErrorBlock } from "../../lib/turnOutcome";
import { passActionsOf } from "../../lib/turnClock";
import type { OpenFileFn } from "../../lib/search";
import { ErrorChip } from "../ErrorChip";
import { CompactionCard } from "../CompactionCard";
import { AgentSpawnRow } from "../AgentSpawnRow";
import { GateCard } from "../GateCard";
import { ReviewCard } from "../ReviewCard";
import { useTurnState } from "../turnState";
import { useTranscriptSession } from "../transcriptSession";
import { GitMerge, Users } from "../../chrome/icons";
import { StatusMark } from "../../components/ui/status";
import { NoticeLine } from "./NoticeLine";
import { PlanHandoffRow } from "./PlanHandoffRow";

/** A system row the host typed: compaction, a spawned agent, a plan handoff,
 *  a review, a gate, a batch or account notice, an error or a turn pass. */
export function isNoticeBlock(block: Block): boolean {
  return !!(
    block.notice ||
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
  if (block.notice?.kind === "batch") return <BatchNotice text={block.text} />;
  if (block.notice?.kind === "account-gone") {
    return <NoticeLine glyph={<Users />} lead={block.text} wrap />;
  }
  if (isErrorBlock(block)) return <ErrorRowView block={block} />;
  const actions = passActionsOf(block);
  if (actions) return <PassRow actions={actions} />;
  return null;
}

/** A driver error row: gray Stopped, or the failure card with its verdict. */
export function ErrorRowView({ block }: { block: Block }) {
  const session = useTurnState();
  const sessionId = useTranscriptSession();
  const row = errorRowOf(session ?? { blocks: [block], status: "idle", thread: undefined }, block);
  if (!sessionId) return null;
  return <ErrorChip sessionId={sessionId} row={row} busy={session?.busy} />;
}

/** A batch's line on the master or a child: a merge it made, or its end. */
function BatchNotice({ text }: { text: string }) {
  const merged = /^Merged by the batch: (.*)$/s.exec(text);
  if (merged) return <NoticeLine glyph={<GitMerge />} lead="Merged by the batch" details={[merged[1]]} />;
  const done = /^Batch done: (.*)$/s.exec(text);
  if (done) {
    return <NoticeLine glyph={<StatusMark state="done" word={false} />} lead="Batch done" details={[done[1]]} />;
  }
  return <NoticeLine glyph={<GitMerge />} lead={text} wrap />;
}

/** What the turn-pass did between turns: "Pass", then its actions. */
export function PassRow({ actions }: { actions: string[] }) {
  return <NoticeLine lead="Pass" details={[actions.join(", ")]} />;
}
