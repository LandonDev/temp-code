// A7 (turn structure): the per-block switch.
import { registry } from "../../lib/connection";
import { hostOfCwd } from "../../lib/tcserver/projects";
import { createContext, memo, useContext, useLayoutEffect, useRef, useState } from "react";
import { HTML_RENDER_COLUMN_WIDTH, htmlRenderFrameHeight, type HtmlRenderReference } from "@shared/htmlRender";
import { Skeleton } from "../../components/ui/skeleton";
import type { ApprovalDecision } from "../../lib/harness";
import { TodoListBlock } from "../TodoListBlock";
import { htmlRenderChunk } from "../chunks";
import { htmlRenderOf } from "../htmlRenderBlock";
import { type Block } from "../../lib/session";
import { AgentMarkdown } from "../AgentMarkdown";
import type { OpenFileFn } from "../../lib/search";
import { useTranscriptHost } from "../transcriptSession";
import { isTodoBlock } from "../transcriptActivity";
import { UserMessageBlock } from "./UserMessage";
import { ToolCall } from "./ToolCall";
import { HandoffDivider, SystemRow } from "./SystemRow";

/** The page the html-render chunk is about to draw, for its placeholder. */
const PendingPage = createContext<HtmlRenderReference | null>(null);

/**
 * Where an agent's page will be while its chunk loads: the column's width
 * and the height the frame reserves at that width (HtmlRenderFrame's
 * `htmlRenderFrameHeight` and `my-1`), one still block with the lg radius,
 * so nothing moves when the page lands.
 */
export function HtmlPagePlaceholder({ reference: given }: { reference?: HtmlRenderReference }) {
  const pending = useContext(PendingPage);
  const reference = given ?? pending;
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(HTML_RENDER_COLUMN_WIDTH);
  useLayoutEffect(() => {
    const measured = box.current?.clientWidth ?? 0;
    if (measured > 0) setWidth(measured);
  }, []);
  const height = reference ? htmlRenderFrameHeight(reference, width) : undefined;
  return (
    <div ref={box} role="status" aria-label="Loading page" aria-busy data-page-placeholder className="my-1 w-full select-none" style={{ height }}>
      <Skeleton className="size-full rounded-lg" />
    </div>
  );
}

// An agent's HTML page renders from the html-render chunk (surfaces/chunks.ts).
export const HtmlRenderRow = htmlRenderChunk.surface("HtmlRenderRow", <HtmlPagePlaceholder />);

export const TranscriptBlock = memo(function TranscriptBlock({
  block,
  stickyIndex,
  cwd,
  onApproval,
  onOpenFile,
  onOpenDiff,
}: {
  block: Block;
  stickyIndex: number;
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
      <PendingPage.Provider value={page}>
        <HtmlRenderRow
          reference={page}
          host={threadHost}
        />
      </PendingPage.Provider>
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
      <div className="min-w-0">
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
      className="min-w-0 text-foreground"
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
