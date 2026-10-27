// A8 (action rows): a tool call outside a group.
import { ChevronRight, CircleDashed, X } from "../../chrome/icons";
import { useState } from "react";
import { FilePreview } from "../../chrome/FilePreview";
import { FileTypeIcon } from "../../chrome/FileTypeIcon";
import { QuestionCard } from "../QuestionCard";
import type { ApprovalDecision } from "../../lib/harness";
import { isEditTool, stubFilePreview } from "../../lib/harness/preview";
import { displayPath, resolveWorkspacePath } from "../../lib/paths";
import { type Block, type ToolPreview } from "../../lib/session";
import type { OpenFileFn } from "../../lib/search";
import { EditRow } from "../EditRow";
import { CallPortLink } from "../CallPortLink";
import { ToolDetails } from "../ToolDetails";
import { FileRefMenu } from "../FileRefMenu";
import { splitEditCards } from "../editCards";
import { AppToolSummary, useAppView } from "../AppToolSummary";
import { useTranscriptHost } from "../transcriptSession";
import {
  editVerb,
  isIncompleteTool,
  needsApproval,
  toolCallLabel,
  toolCallState,
  type ToolCallState,
} from "../transcriptActivity";
import { ApprovalControls } from "./Approval";

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
  onApproval?: (requestId: string | number, decision: ApprovalDecision) => void;
  onOpenFile?: OpenFileFn;
  onOpenDiff?: (path: string) => void;
  embedded?: boolean;
  /** Render as a plain tool row even when the call is an edit (a memory-file edit). */
  plain?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const app = useAppView(block);
  const preview = block.tool?.preview;
  const label = toolCallLabel(block, cwd);
  const state = toolCallState(block);
  const stateLabel =
    state === "accepted"
      ? "Accepted"
      : state === "rejected"
        ? "Rejected"
        : "Pending";
  const editTool = isEditTool(
    block.tool?.kind,
    block.text || block.tool?.title,
    preview,
  );
  // Every call opens onto its details; the body mounts only once asked for.
  const expandable = !!block.tool && !needsApproval(block);

  const frame = embedded ? "py-0.5" : "py-1";

  if (block.question) {
    return (
      <div className={frame}>
        <div className="text-[12px] text-content/50">{label}</div>
        <QuestionCard question={block.question} />
      </div>
    );
  }

  if (editTool && !plain) {
    if (needsApproval(block)) {
      return (
        <div className={frame}>
          <FilePreview
            preview={preview ?? stubFilePreview(block.tool?.kind, label)}
            status={state}
            cwd={cwd}
            onOpenFile={onOpenDiff ?? onOpenFile}
          />
          <ApprovalControls block={block} onApproval={onApproval} />
        </div>
      );
    }
    // One card per file the call touched; app bookkeeping as a quiet row.
    const { cards, internal } = splitEditCards(block);
    return (
      <>
        {cards.map((card) => (
          <div key={card.id} className={frame}>
            <EditRow block={card} cwd={cwd} onOpenFile={onOpenDiff ?? onOpenFile} />
          </div>
        ))}
        {internal ? (
          <ToolCall block={internal} cwd={cwd} embedded={embedded} onOpenFile={onOpenFile} plain />
        ) : null}
      </>
    );
  }

  if (isIncompleteTool(block, label, state)) return null;

  return (
    <div className={frame}>
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${stateLabel} tool call: ${label}`}
          onClick={() => setOpen((value) => !value)}
          className="flex w-full min-w-0 items-center gap-2 rounded-lg py-1.5 text-left"
        >
          <ToolCallIcon state={state} />
          {app ? (
            <AppToolSummary view={app} failed={state === "rejected"} />
          ) : (
            <ToolCallSummary
              label={label}
              preview={preview}
              cwd={cwd}
              failed={state === "rejected"}
              onOpenFile={onOpenFile}
            />
          )}
          <ChevronRight
            className={`size-3.5 shrink-0 text-content/40 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
            strokeWidth={1.75}
          />
        </button>
      ) : (
        <div
          aria-label={`${stateLabel} tool call: ${label}`}
          className="flex w-full min-w-0 items-center gap-2"
        >
          <ToolCallIcon state={state} />
          {app ? (
            <AppToolSummary view={app} failed={state === "rejected"} />
          ) : (
            <ToolCallSummary
              label={label}
              preview={preview}
              cwd={cwd}
              failed={state === "rejected"}
              onOpenFile={onOpenFile}
            />
          )}
        </div>
      )}
      {/* Outside the row's button: a dev server the call opened. */}
      <div className="flex pl-5">
        <CallPortLink callId={block.tool?.callId} />
      </div>
      {open && expandable ? <ToolDetails block={block} /> : null}
      <ApprovalControls block={block} onApproval={onApproval} />
    </div>
  );
}

export function ToolCallSummary({
  label,
  preview,
  cwd,
  onOpenFile,
  interactive = true,
  chip = false,
  failed = false,
}: {
  label: string;
  preview?: ToolPreview;
  cwd?: string;
  onOpenFile?: OpenFileFn;
  interactive?: boolean;
  /** Sets the file off in a chip, for rows that lean on a rail for structure. */
  chip?: boolean;
  failed?: boolean;
}) {
  // A path the thread named opens on the thread's host (lib/pathHost.ts).
  const threadHost = useTranscriptHost();
  const parts = label.match(/^(Read|Find|Skill|List|Edit|Write)\s+(.+)$/);
  // A write preview carries the path itself, so edits get the same verb + file
  // chip as reads rather than falling through to a raw label.
  const writeTarget =
    preview?.kind === "write"
      ? preview.path
        ? displayPath(preview.path, cwd)
        : preview.fileName
      : undefined;
  const action =
    parts?.[1] ??
    (writeTarget ? editVerb(label) : undefined) ??
    (/^read$/i.test(label.trim()) && (preview?.path || preview?.fileName)
      ? "Read"
      : /^find$/i.test(label.trim()) && preview?.query
        ? "Find"
        : /^list$/i.test(label.trim()) && (preview?.path || preview?.fileName)
          ? "List"
          : /^skill$/i.test(label.trim())
            ? "Skill"
            : undefined);
  const target =
    parts?.[2] ??
    writeTarget ??
    (action === "Read" ||
    action === "List" ||
    action === "Edit" ||
    action === "Write"
      ? preview?.path
        ? displayPath(preview.path, cwd)
        : preview?.fileName
      : action === "Find"
        ? preview?.query
        : undefined);
  if (!action || !target) {
    return (
      <span
        className={`min-w-0 flex-1 truncate font-mono text-[13px] ${
          failed ? "text-danger" : chip ? "text-content/70" : "text-content/70"
        }`}
      >
        {label}
      </span>
    );
  }
  const isFile = action !== "Find" && action !== "Skill";
  const fileName =
    preview?.fileName ||
    target
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .filter(Boolean)
      .pop() ||
    "file";
  const filePath = resolveWorkspacePath(preview?.path || target, cwd);
  const canOpen = interactive && !!onOpenFile && !!filePath;
  const actionTone = failed ? "text-danger" : "text-content/50";
  const targetTone = failed
    ? "text-danger"
    : chip
      ? "text-content/70"
      : "text-content";

  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-[13px]">
      <span className={`shrink-0 font-sans text-sm ${actionTone}`}>
        {action}
      </span>
      {isFile ? (
        <FileRefMenu target={preview?.path || target} cwd={cwd}>
        {canOpen ? (
          <button
            type="button"
            className={`-my-0.5 flex min-w-0 cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-left hover:text-info ${
              chip
                ? `max-w-full bg-content/6 hover:bg-content/10 ${targetTone}`
                : `flex-1 hover:underline ${targetTone}`
            }`}
            title={preview?.path || target}
            onClick={(event) => {
              event.stopPropagation();
              onOpenFile?.(filePath, undefined, threadHost ? { environmentId: threadHost } : undefined);
            }}
          >
            <FileTypeIcon name={fileName} isDir={action === "List"} />
            <span className="min-w-0 truncate">{target}</span>
          </button>
        ) : (
          <span
            className={`-my-0.5 flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 ${
              chip
                ? `max-w-full bg-content/6 ${targetTone}`
                : `flex-1 ${targetTone}`
            }`}
            title={preview?.path || target}
          >
            <FileTypeIcon name={fileName} isDir={action === "List"} />
            <span className="min-w-0 truncate">{target}</span>
          </span>
        )}
        </FileRefMenu>
      ) : (
        <span
          className={`flex min-w-0 flex-1 items-center gap-1.5 pl-1 ${targetTone}`}
          title={target}
        >
          <span className="min-w-0 truncate">{target}</span>
        </span>
      )}
    </span>
  );
}

export function ToolCallIcon({ state }: { state: ToolCallState }) {
  if (state === "rejected") {
    return <X className="size-3.5 shrink-0 text-danger" strokeWidth={2} />;
  }
  if (state === "pending") {
    return (
      <CircleDashed
        className="size-3.5 shrink-0 text-content/40"
        strokeWidth={1.75}
      />
    );
  }
  return null;
}
