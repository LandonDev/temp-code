// A8 (action rows): a tool call outside a group.
import { isEditTool } from "../../lib/harness/preview";
import { type Block } from "../../lib/session";
import type { OpenFileFn } from "../../lib/search";
import { EditRow } from "../EditRow";
import { splitEditCards } from "../editCards";
import { isIncompleteTool, needsApproval, toolCallLabel, toolCallState } from "../transcriptActivity";
import { ActionRow } from "./ActionRow";
import type { ApprovalHandler } from "./types";

/**
 * A call the turn shows on its own: each file it changed as an edit row,
 * anything else as one action row. Looks the same as the rows in a group.
 */
export function ToolCall({
  block,
  cwd,
  onApproval,
  onOpenFile,
  onOpenDiff,
  plain = false,
}: {
  block: Block;
  cwd?: string;
  onApproval?: ApprovalHandler;
  onOpenFile?: OpenFileFn;
  onOpenDiff?: (path: string) => void;
  /** Kept for TranscriptBlock's call; rows look the same anywhere. */
  embedded?: boolean;
  /** Render as a plain tool row even when the call is an edit (a memory-file edit). */
  plain?: boolean;
}) {
  const preview = block.tool?.preview;
  const label = toolCallLabel(block, cwd);
  const editTool = isEditTool(block.tool?.kind, block.text || block.tool?.title, preview);

  // One row per file an edit touched, app bookkeeping as a plain row. An
  // edit still waiting on approval is an action row: its card shows the ask.
  if (editTool && !plain && !block.question && !needsApproval(block)) {
    const { cards, internal } = splitEditCards(block);
    return (
      <>
        {cards.map((card) => (
          <EditRow key={card.id} block={card} cwd={cwd} onOpenFile={onOpenDiff ?? onOpenFile} />
        ))}
        {internal ? <ActionRow block={internal} cwd={cwd} onOpenFile={onOpenFile} /> : null}
      </>
    );
  }

  if (isIncompleteTool(block, label, toolCallState(block))) return null;

  return <ActionRow block={block} cwd={cwd} onApproval={onApproval} onOpenFile={onOpenFile} />;
}
