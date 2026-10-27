// A9 (thinking): a thinking row in a group.
import { Minus } from "../../chrome/icons";
import { useState } from "react";
import { type Block } from "../../lib/session";
import { AgentMarkdown } from "../AgentMarkdown";
import type { OpenFileFn } from "../../lib/search";
import { proseSummary } from "../transcriptActivity";

/**
 * The line that keeps a long think from reading as a stall. Opening the fold
 * around it does not open the thought itself — reasoning is only ever read on
 * purpose, one line until you ask for it.
 */
export function ActivityThinkingRow({
  block,
  cwd,
  expandable = false,
  bare = false,
  onOpenFile,
}: {
  block: Block;
  cwd?: string;
  expandable?: boolean;
  bare?: boolean;
  /** When the thought settled (its turn item's end): the row's duration reads from it. */
  endTs?: number;
  onOpenFile?: OpenFileFn;
}) {
  const [open, setOpen] = useState(false);
  // The thought mounts on first open and stays; the grid track does the reveal.
  const [mounted, setMounted] = useState(false);
  // A thought we watched arrive rises in; history sits still.
  const [fresh] = useState(!!block.streaming);
  const text = proseSummary(block.text) || "Thinking";
  // In a group the rail is the bullet, so there is nothing to breathe while
  // reasoning streams in — the line itself does.
  const pulse = block.streaming ? "zen-thinking-pulse" : "";
  const icon = bare ? null : (
    <Minus
      className={`size-3.5 shrink-0 text-content/40 ${pulse}`}
      strokeWidth={1.75}
    />
  );
  const label = (
    <span
      className={`min-w-0 flex-1 truncate font-sans text-sm text-content/50 ${
        bare ? pulse : ""
      }`}
    >
      {text}
    </span>
  );

  if (!expandable) {
    return (
      <div
        aria-label={`Thinking: ${text}`}
        className={`flex min-w-0 items-center gap-1.5 py-1 ${fresh ? "z-fade-in" : ""}`}
      >
        {icon}
        {label}
      </div>
    );
  }

  return (
    <div className={`flex min-w-0 flex-col ${fresh ? "z-fade-in" : ""}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? "Hide thinking" : `Show thinking: ${text}`}
        onClick={() => {
          setMounted(true);
          setOpen((value) => !value);
        }}
        className="group flex min-w-0 items-center gap-1.5 py-1 text-left"
      >
        {icon}
        <span
          className={`min-w-0 flex-1 truncate font-sans text-sm text-content/50 transition-colors group-hover:text-content/70 ${
            bare ? pulse : ""
          }`}
        >
          {text}
        </span>
      </button>
      <div
        className="thinking-body grid"
        style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}
      >
        <div className="min-h-0 overflow-hidden">
          {mounted ? (
            <div className={`min-w-0 pb-2 ${bare ? "" : "pl-5"}`}>
              <AgentMarkdown
                className="agent-reasoning"
                text={block.text}
                cwd={cwd}
                onOpenFile={onOpenFile}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
