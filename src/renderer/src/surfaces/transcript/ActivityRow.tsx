// A8 (action rows): one action row in a group.
import { type Block } from "../../lib/session";
import type { OpenFileFn } from "../../lib/search";
import { EditRow } from "../EditRow";
import { splitEditCards } from "../editCards";
import { isEditBlock } from "../editModel";
import { isThinkingBlock, needsApproval } from "../transcriptActivity";
import { ActivityThinkingRow } from "./ThinkingRow";
import { ApprovalControls } from "./Approval";
import { ActionRow } from "./ActionRow";
import type { ApprovalHandler } from "./types";

/**
 * One step of the agent's work, a tool call or a thought: each file an edit
 * changed as its own edit row, any other call as one action row. Every row
 * looks the same wherever the group puts it.
 */
export function ActivityRow({
  block,
  cwd,
  expanded = false,
  endTs,
  onApproval,
  onOpenFile,
  onOpenDiff,
}: {
  block: Block;
  cwd?: string;
  expanded?: boolean;
  /** The turn is live; a row speaks in its own call's tense either way. */
  live?: boolean;
  /** A thought's settled time (its turn item's end), for "Thought for 4s". */
  endTs?: number;
  onApproval?: ApprovalHandler;
  onOpenFile?: OpenFileFn;
  onOpenDiff?: (path: string) => void;
}) {
  if (isThinkingBlock(block)) {
    return (
      <ActivityThinkingRow block={block} cwd={cwd} expandable={expanded} endTs={endTs} onOpenFile={onOpenFile} />
    );
  }
  if (isEditBlock(block) && !needsApproval(block) && !block.question) {
    const { cards, internal } = splitEditCards(block);
    return (
      <>
        {cards.map((card) => (
          <EditRow key={card.id} block={card} cwd={cwd} onOpenFile={onOpenDiff ?? onOpenFile} />
        ))}
        {internal ? <ActionRow block={internal} cwd={cwd} onOpenFile={onOpenFile} /> : null}
        {/* A decided board leaves its one-line verdict under the edit it judged. */}
        <ApprovalControls block={block} onApproval={onApproval} />
      </>
    );
  }
  return <ActionRow block={block} cwd={cwd} onApproval={onApproval} onOpenFile={onOpenFile} />;
}
