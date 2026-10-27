// A8 (action rows): one action row in a group.
import { ChevronRight, CircleDashed, Minus, X } from "../../chrome/icons";
import { useState } from "react";
import { QuestionCard } from "../QuestionCard";
import type { ApprovalDecision } from "../../lib/harness";
import { isEditTool } from "../../lib/harness/preview";
import { type Block } from "../../lib/session";
import {
  ConnectorMark,
  ConnectorSummary,
  ReconnectChip,
  SubagentMark,
  SubagentSteps,
} from "../ToolChips";
import { isAgentCall, mcpServerOf } from "../toolMarks";
import { AgentMarkdown } from "../AgentMarkdown";
import type { OpenFileFn } from "../../lib/search";
import { EditRow } from "../EditRow";
import { CallPortLink } from "../CallPortLink";
import { ToolDetails } from "../ToolDetails";
import { splitEditCards } from "../editCards";
import { AppToolSummary, useAppView } from "../AppToolSummary";
import { isEditBlock } from "../editModel";
import {
  isThinkingBlock,
  isProseBlock,
  needsApproval,
  proseSummary,
  toolCallLabel,
  toolCallState,
  type ToolCallState,
} from "../transcriptActivity";
import { ActivityThinkingRow } from "./ThinkingRow";
import { ApprovalControls } from "./Approval";
import { ToolCallSummary } from "./ToolCall";

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
  live = false,
  variant = "stack",
  endTs,
  onApproval,
  onOpenFile,
  onOpenDiff,
}: {
  block: Block;
  cwd?: string;
  expanded?: boolean;
  live?: boolean;
  variant?: "stack" | "phase";
  /** A thought's settled time (its turn item's end), for "Thought for 4s". */
  endTs?: number;
  onApproval?: (requestId: string | number, decision: ApprovalDecision) => void;
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
        {internal ? (
          <ActivityToolRow
            block={internal}
            cwd={cwd}
            live={live}
            bare={railed}
            onOpenFile={onOpenFile}
          />
        ) : null}
        {/* A decided board leaves its one-line verdict under the edit it judged. */}
        <ApprovalControls block={block} onApproval={onApproval} />
      </>
    );
  }
  return (
    <ActivityToolRow
      block={block}
      cwd={cwd}
      live={live}
      bare={railed}
      onApproval={onApproval}
      onOpenFile={onOpenFile}
      onOpenDiff={onOpenDiff}
    />
  );
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

export function ActivityToolRow({
  block,
  cwd,
  live = false,
  bare = false,
  onApproval,
  onOpenFile,
  onOpenDiff,
}: {
  block: Block;
  cwd?: string;
  live?: boolean;
  bare?: boolean;
  onApproval?: (requestId: string | number, decision: ApprovalDecision) => void;
  onOpenFile?: OpenFileFn;
  onOpenDiff?: (path: string) => void;
}) {
  const label = toolCallLabel(block, cwd);
  const state = toolCallState(block);
  const pending = needsApproval(block);
  const openFile = isEditTool(
    block.tool?.kind,
    block.text || block.tool?.title,
    block.tool?.preview,
  )
    ? (onOpenDiff ?? onOpenFile)
    : onOpenFile;
  // A call we watched start rises in; rows already settled at mount sit still.
  const [fresh] = useState(live && state === "pending");
  const [open, setOpen] = useState(false);
  const app = useAppView(block);
  // Every call opens onto its details; the body mounts only once asked for.
  const expandable = !!block.tool && !pending && !block.question;
  // The app's own tools (mcp__app__*) are the app itself, not a connector —
  // no brand reads on them. Everything else that went through MCP gets the
  // connector's mark: a real logo where we have one, a plug glyph otherwise.
  const mcpServer = mcpServerOf(block.tool?.name ?? "");
  const connector = mcpServer && mcpServer !== "app" ? mcpServer : null;

  return (
    <div data-block={block.id} className={`flex min-w-0 flex-col ${fresh ? "z-fade-in" : ""}`}>
      <div
        aria-label={`Tool call: ${label}`}
        className={`group/tool flex min-w-0 items-center gap-1.5 py-1 ${expandable ? "cursor-pointer" : ""}`}
        onClick={expandable ? () => setOpen((value) => !value) : undefined}
      >
        {bare ? null : state === "pending" ? (
          <ActivityToolIcon state={state} live={live} />
        ) : block.tool?.display?.app ? (
          <ConnectorMark app={block.tool.display.app} />
        ) : isAgentCall(block) ? (
          <SubagentMark block={block} />
        ) : connector ? (
          <ConnectorMark app={connector} />
        ) : (
          <ActivityToolIcon state={state} live={live} />
        )}
        {block.tool?.display?.app ? (
          <ConnectorSummary display={block.tool.display} chip={bare} failed={state === "rejected"} />
        ) : app ? (
          <AppToolSummary view={app} chip={bare} failed={state === "rejected"} agent={isAgentCall(block)} />
        ) : (
          <ToolCallSummary
            label={label}
            preview={block.tool?.preview}
            cwd={cwd}
            chip={bare}
            failed={state === "rejected"}
            onOpenFile={openFile}
          />
        )}
        <SubagentSteps count={block.tool?.subCount} />
        <CallPortLink callId={block.tool?.callId} />
        {block.tool?.reauth ? <ReconnectChip reauth={block.tool.reauth} /> : null}
        {pending || block.question ? null : <ToolCallStatusIcon state={state} />}
        {expandable ? <ToolDisclosure open={open} /> : null}
      </div>
      {open && expandable ? <ToolDetails block={block} /> : null}
      {/* Pending: the board. Decided: its one-line verdict. Neither: nothing. */}
      <ApprovalControls block={block} onApproval={onApproval} />
      {block.question ? <QuestionCard question={block.question} /> : null}
    </div>
  );
}

/** The chevron that opens a row onto its details: quiet until hovered. */
export function ToolDisclosure({ open }: { open: boolean }) {
  return (
    <ChevronRight
      className={`ml-auto size-3.5 shrink-0 text-content/40 transition-transform duration-150 ${
        open ? "rotate-90" : "opacity-0 group-hover/tool:opacity-100"
      }`}
      strokeWidth={1.75}
    />
  );
}

export function ActivityToolIcon({
  state,
  live = false,
}: {
  state: ToolCallState;
  live?: boolean;
}) {
  if (state === "pending") {
    return (
      <CircleDashed
        className={`size-3.5 shrink-0 text-content/40 ${live ? "zen-tool-spin" : ""}`}
        strokeWidth={1.75}
      />
    );
  }

  return (
    <Minus className="size-3.5 shrink-0 text-content/50" strokeWidth={1.75} />
  );
}

/** Failure stays marked. Running and success do not get a trailing icon. */
export function ToolCallStatusIcon({ state }: { state: ToolCallState }) {
  if (state === "rejected") {
    return <X className="size-3.5 shrink-0 text-danger" strokeWidth={2} />;
  }
  return null;
}
