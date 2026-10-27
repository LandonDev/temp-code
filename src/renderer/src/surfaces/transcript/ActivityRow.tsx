// A8 (action rows): one action row in a group.
import { Minus } from "../../chrome/icons";
import { useState } from "react";
import { type Block } from "../../lib/session";
import { AgentMarkdown } from "../AgentMarkdown";
import type { OpenFileFn } from "../../lib/search";
import { EditRow } from "../EditRow";
import { splitEditCards } from "../editCards";
import { isEditBlock } from "../editModel";
import {
  isThinkingBlock,
  isProseBlock,
  needsApproval,
  proseSummary,
} from "../transcriptActivity";
import { ActivityThinkingRow } from "./ThinkingRow";
import { ApprovalControls } from "./Approval";
import { ActionRow } from "./ActionRow";
import type { ApprovalHandler } from "./types";

/** One activity row: py-1 around a 20px line. */
export const ACTIVITY_ROW_HEIGHT = "h-7";

export const DISCLOSURE_ROW = "flex w-fit items-center gap-1.5 py-1 font-sans text-sm";

/**
 * One step of the agent's work, whatever that step was: a tool call, a thought,
 * a paragraph. In a phase the rail draws the bullet, so the row drops its own
 * leading icon and leans on the rail instead.
 */
export function ActivityRow({
  block,
  cwd,
  expanded = false,
  variant = "stack",
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
  variant?: "stack" | "phase";
  /** A thought's settled time (its turn item's end), for "Thought for 4s". */
  endTs?: number;
  onApproval?: ApprovalHandler;
  onOpenFile?: OpenFileFn;
  onOpenDiff?: (path: string) => void;
}) {
  const railed = variant === "phase";
  if (isThinkingBlock(block)) {
    return (
      <ActivityThinkingRow
        block={block}
        cwd={cwd}
        expandable={expanded || railed}
        bare={railed}
        endTs={endTs}
        onOpenFile={onOpenFile}
      />
    );
  }
  if (isProseBlock(block)) {
    if (railed) {
      return (
        <ActivityNoteRow
          block={block}
          cwd={cwd}
          bare
          expandable
          onOpenFile={onOpenFile}
        />
      );
    }
    return expanded ? (
      <div className="flex min-w-0 gap-1.5 py-1 text-content">
        <Minus
          className="mt-[5px] size-3.5 shrink-0 text-content/50"
          strokeWidth={1.75}
        />
        <div className="min-w-0 flex-1">
          <AgentMarkdown text={block.text} cwd={cwd} onOpenFile={onOpenFile} />
        </div>
      </div>
    ) : (
      <ActivityNoteRow block={block} />
    );
  }
  if (isEditBlock(block) && !needsApproval(block) && !block.question) {
    const { cards, internal } = splitEditCards(block);
    return (
      <>
        {cards.map((card) => (
          <div key={card.id} className="py-1">
            <EditRow block={card} cwd={cwd} onOpenFile={onOpenDiff ?? onOpenFile} />
          </div>
        ))}
        {internal ? <ActionRow block={internal} cwd={cwd} onOpenFile={onOpenFile} /> : null}
        {/* A decided board leaves its one-line verdict under the edit it judged. */}
        <ApprovalControls block={block} onApproval={onApproval} />
      </>
    );
  }
  return <ActionRow block={block} cwd={cwd} onApproval={onApproval} onOpenFile={onOpenFile} />;
}

/**
 * A line the agent wrote mid-run, kept to one line. It opens on click, so
 * folding the work never costs you a paragraph you wanted to read.
 */
export function ActivityNoteRow({
  block,
  cwd,
  bare = false,
  expandable = false,
  onOpenFile,
}: {
  block: Block;
  cwd?: string;
  bare?: boolean;
  expandable?: boolean;
  onOpenFile?: OpenFileFn;
}) {
  const [open, setOpen] = useState(false);
  const text = proseSummary(block.text);
  const icon = bare ? null : (
    <Minus className="size-3.5 shrink-0 text-content/50" strokeWidth={1.75} />
  );

  if (!expandable) {
    return (
      <div
        aria-label={`Agent said: ${text}`}
        className="flex min-w-0 items-center gap-1.5 py-1"
      >
        {icon}
        <span className="min-w-0 flex-1 truncate font-sans text-sm text-content/70">
          {text}
        </span>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? "Hide the full note" : `Agent said: ${text}`}
        onClick={() => setOpen((value) => !value)}
        className="group flex min-w-0 items-center gap-1.5 py-1 text-left"
      >
        {icon}
        <span className="min-w-0 flex-1 truncate font-sans text-sm text-content/70 transition-colors group-hover:text-content">
          {text}
        </span>
      </button>
      {open ? (
        <div className="min-w-0 pb-2">
          <AgentMarkdown text={block.text} cwd={cwd} onOpenFile={onOpenFile} />
        </div>
      ) : null}
    </div>
  );
}
