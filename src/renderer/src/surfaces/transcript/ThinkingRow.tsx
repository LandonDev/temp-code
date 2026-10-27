// A9 (thinking): a thinking row in a group.
import { useState } from "react";
import { ChevronRight, Sparkles } from "../../chrome/icons";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../components/ui/collapsible";
import { TextShimmer } from "../../components/ui/text-shimmer";
import { cn } from "../../lib/cn";
import { type Block } from "../../lib/session";
import type { OpenFileFn } from "../../lib/search";
import { AgentMarkdown } from "../AgentMarkdown";
import { latestLine, thoughtLabel, thoughtMs } from "./thinking";

/** One row of the action list: the 14px glyph slot, then the words. */
const ROW = "flex min-h-8 min-w-0 items-center gap-2 font-sans text-sm";
const GLYPH = <Sparkles className="size-3.5 shrink-0 text-muted-foreground" />;

/**
 * A thought, as one row of the paragraph's action list. While it streams:
 * "Thinking" shimmering and the newest finished sentence after it. Once it
 * ends: "Thought for 4s", which opens the whole text. Reasoning is only read
 * on purpose.
 */
export function ActivityThinkingRow({
  block,
  cwd,
  expandable = false,
  endTs,
  onOpenFile,
}: {
  block: Block;
  cwd?: string;
  /** False: a line that does not open. */
  expandable?: boolean;
  /** Accepted for A7's callers; the glyph slot is always drawn. */
  bare?: boolean;
  /** When the thought settled (the next block's time, or the turn's end). */
  endTs?: number;
  onOpenFile?: OpenFileFn;
}) {
  const [open, setOpen] = useState(false);
  // The text mounts on first open and stays mounted.
  const [opened, setOpened] = useState(false);

  if (block.streaming) {
    const line = latestLine(block.text);
    return (
      <div aria-label="Thinking" className={ROW}>
        {GLYPH}
        <TextShimmer className="shrink-0">Thinking</TextShimmer>
        {line ? <span className="min-w-0 truncate text-muted-foreground">{line}</span> : null}
      </div>
    );
  }

  const label = thoughtLabel(thoughtMs(block, endTs));
  if (!expandable) {
    return (
      <div className={cn(ROW, "text-muted-foreground")}>
        {GLYPH}
        <span className="truncate">{label}</span>
      </div>
    );
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        if (next) setOpened(true);
        setOpen(next);
      }}
      className="min-w-0"
    >
      <CollapsibleTrigger className={cn(ROW, "w-fit text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground")}>
        {GLYPH}
        <span className="truncate">{label}</span>
        <ChevronRight
          className={cn(
            "size-3 shrink-0 transition-transform duration-(--dur-fast) ease-(--ease-out) motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent keepMounted={opened}>
        <div className="min-w-0 pb-2 pl-5.5">
          {opened ? (
            <AgentMarkdown
              className="agent-reasoning"
              size="compact"
              text={block.text}
              cwd={cwd}
              onOpenFile={onOpenFile}
            />
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
