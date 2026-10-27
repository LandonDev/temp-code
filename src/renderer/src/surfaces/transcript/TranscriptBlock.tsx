// A7 (turn structure): the per-block switch.
import { registry } from "../../lib/connection";
import { hostOfCwd } from "../../lib/tcserver/projects";
import { memo } from "react";
import type { ApprovalDecision } from "../../lib/harness";
import { TodoListBlock } from "../TodoListBlock";
import { htmlRenderChunk } from "../chunks";
import { SurfaceSkeleton } from "../SurfaceSkeleton";
import { htmlRenderOf } from "../htmlRenderBlock";
import { type Block } from "../../lib/session";
import { AgentMarkdown } from "../AgentMarkdown";
import type { OpenFileFn } from "../../lib/search";
import { useTranscriptHost } from "../transcriptSession";
import { isTodoBlock } from "../transcriptActivity";
import { UserMessageBlock } from "./UserMessage";
import { ToolCall } from "./ToolCall";
import { HandoffDivider, SystemRow } from "./SystemRow";

// An agent's HTML page renders from the html-render chunk (surfaces/chunks.ts).
export const HtmlRenderRow = htmlRenderChunk.surface("HtmlRenderRow", <SurfaceSkeleton kind="frame" label="Loading page" />);

export const TranscriptBlock = memo(function TranscriptBlock({
  block,
  stickyIndex,
  compactTop = false,
  cwd,
  onApproval,
  onOpenFile,
  onOpenDiff,
}: {
  block: Block;
  stickyIndex: number;
  compactTop?: boolean;
  cwd?: string;
  onApproval?: (requestId: string | number, decision: ApprovalDecision) => void;
  onOpenFile?: OpenFileFn;
  onOpenDiff?: (path: string) => void;
}) {
  // The thread's own host: its attachments and pages live there, whatever the cwd says.
  const threadHost = useTranscriptHost() ?? (cwd ? hostOfCwd(cwd) : registry.primary().environmentId);
  if (block.role === "user") {
    return (
      <UserMessageBlock
        block={block}
        stickyIndex={stickyIndex}
        environmentId={threadHost}
      />
    );
  }

  if (isTodoBlock(block)) {
    return <TodoListBlock block={block} />;
  }

  const page = htmlRenderOf(block);
  if (page) {
    return (
      <HtmlRenderRow
        reference={page}
        host={threadHost}
      />
    );
  }

  if (block.role === "tool") {
    return (
      <ToolCall
        block={block}
        cwd={cwd}
        onApproval={onApproval}
        onOpenFile={onOpenFile}
        onOpenDiff={onOpenDiff}
      />
    );
  }

  if (block.role === "reasoning") {
    return null;
  }

  if (block.role === "plan") {
    return (
      <div className="py-1">
        <AgentMarkdown
          text={block.text}
          streaming={block.streaming}
          cwd={cwd}
          onOpenFile={onOpenFile}
        />
      </div>
    );
  }

  if (block.role === "approval") {
    return (
      <ToolCall
        block={block}
        cwd={cwd}
        onApproval={onApproval}
        onOpenFile={onOpenFile}
        onOpenDiff={onOpenDiff}
      />
    );
  }

  if (block.role === "handoff") {
    return <HandoffDivider block={block} />;
  }

  if (block.role === "system") {
    return <SystemRow block={block} cwd={cwd} onOpenFile={onOpenFile} />;
  }

  if (!block.text && block.streaming) return null;

  return (
    <div
      data-block={block.id}
      data-selectable-agent-response={block.streaming ? undefined : block.id}
      className={`min-w-0 pb-1 text-content ${compactTop ? "pt-2" : "pt-3"}`}
    >
      <AgentMarkdown
        text={block.text}
        streaming={block.streaming}
        cwd={cwd}
        onOpenFile={onOpenFile}
      />
    </div>
  );
});
