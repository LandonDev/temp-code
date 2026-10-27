// A8 (action rows): a tool call outside a group.
import { FilePreview } from "../../chrome/FilePreview";
import { isEditTool, stubFilePreview } from "../../lib/harness/preview";
import { type Block } from "../../lib/session";
import type { OpenFileFn } from "../../lib/search";
import { EditRow } from "../EditRow";
import { splitEditCards } from "../editCards";
import { isIncompleteTool, needsApproval, toolCallLabel, toolCallState } from "../transcriptActivity";
import { ActionRow } from "./ActionRow";
import { ApprovalControls } from "./Approval";
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
  embedded,
  plain = false,
}: {
  block: Block;
  cwd?: string;
  onApproval?: ApprovalHandler;
  onOpenFile?: OpenFileFn;
  onOpenDiff?: (path: string) => void;
  embedded?: boolean;
  /** Render as a plain tool row even when the call is an edit (a memory-file edit). */
  plain?: boolean;
}) {
  const preview = block.tool?.preview;
  const label = toolCallLabel(block, cwd);
  const frame = embedded ? "py-0.5" : "py-1";
  const editTool = isEditTool(block.tool?.kind, block.text || block.tool?.title, preview);

  if (editTool && !plain && !block.question) {
    if (needsApproval(block)) {
      return (
        <div className={frame}>
          <FilePreview
            preview={preview ?? stubFilePreview(block.tool?.kind, label)}
            status={toolCallState(block)}
            cwd={cwd}
            onOpenFile={onOpenDiff ?? onOpenFile}
          />
          <ApprovalControls block={block} onApproval={onApproval} />
        </div>
      );
    }
    // One row per file the call touched; app bookkeeping as a plain row.
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
