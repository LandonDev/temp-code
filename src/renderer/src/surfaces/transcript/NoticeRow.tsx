// A9 (notices): every typed notice row, through one switch.
import type { Block } from "../../lib/session";
import { errorRowOf, isErrorBlock, stopClosesTurn } from "../../lib/turnOutcome";
import { passActionsOf } from "../../lib/turnClock";
import { useSessionMeta } from "../../lib/tcserver/store";
import type { OpenFileFn } from "../../lib/search";
import { ErrorChip } from "../ErrorChip";
import { CompactionCard } from "../CompactionCard";
import { AgentSpawnRow } from "../AgentSpawnRow";
import { GateCard } from "../GateCard";
import { reviewChunk } from "../chunks";
import { Skeleton } from "../../components/ui/skeleton";
import { useTurnState } from "../turnState";
import { useTranscriptSession } from "../transcriptSession";
import { GitMerge, Users } from "../../chrome/icons";
import { StatusMark } from "../../components/ui/status";
import { NoticeLine } from "./NoticeLine";
import { PlanHandoffRow } from "./PlanHandoffRow";

/** A review's notice loads with its chunk, warmed with the first thread's;
 *  until then a 28px line in the notice's shape holds its place. */
const ReviewCard = reviewChunk.surface(
  "ReviewCard",
  <div aria-hidden className="flex h-7 items-center gap-2">
    <Skeleton className="size-3.5 rounded-full" />
    <Skeleton className="h-3 w-40" />
  </div>,
);

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
  if (block.notice?.kind === "plan-build") return <PlanBuildNotice text={block.text} />;
  if (isErrorBlock(block)) return <ErrorRowView block={block} />;
  const actions = passActionsOf(block);
  if (actions) return <PassRow actions={actions} />;
  return null;
}

/** A driver error row: the failure card with its verdict, or gray Stopped where no closing line says it. */
export function ErrorRowView({ block }: { block: Block }) {
  const session = useTurnState();
  const sessionId = useTranscriptSession();
  // The tree's continue flag lives on the meta until the projection carries it.
  const meta = useSessionMeta(sessionId);
  const outcome = session
    ? { ...session, treeCanContinue: session.treeCanContinue ?? meta?.treeCanContinue }
    : { blocks: [block], status: "idle" as const, thread: undefined };
  // The turn's closing line (TurnEnd) says Stopped; the row stays only while its turn is open.
  if (!sessionId || stopClosesTurn(outcome, block)) return null;
  const row = errorRowOf(outcome, block);
  return <ErrorChip sessionId={sessionId} row={row} busy={session?.busy} />;
}

/** A plan's automatic build that could not start, with the host's reason. */
function PlanBuildNotice({ text }: { text: string }) {
  const why = /^The build did not start: (.*)$/s.exec(text);
  const glyph = <StatusMark state="failed" word={false} />;
  if (!why) return <NoticeLine glyph={glyph} lead={text} wrap />;
  return <NoticeLine glyph={glyph} lead="The build did not start" details={[why[1]]} wrap />;
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
