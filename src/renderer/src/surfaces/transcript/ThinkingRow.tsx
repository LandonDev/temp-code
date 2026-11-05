// A9 (thinking): a settled thought, in a group opened by hand.
import { useState } from "react";
import { ChevronRight, Sparkles } from "../../chrome/icons";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../components/ui/collapsible";
import { cn } from "../../lib/cn";
import { type Block } from "../../lib/session";
import type { OpenFileFn } from "../../lib/search";
import { AgentMarkdown } from "../AgentMarkdown";
import { STEP_LINE } from "./stepLine";

/** One row of the action list on the step grid: the 14px glyph slot, then the words. */
const ROW = STEP_LINE;

/**
 * A thought that settled, as one row of a group a person opened: "Thought ›",
 * which opens the whole text. It carries no duration: how long the model
 * thought is noise. A thought streaming is the turn's working line, never a
 * row (WorkingLine.tsx), and a group the person did not open shows no
 * thought at all (ActionGroup.tsx).
 */
export function ActivityThinkingRow({
  block,
  cwd,
  expandable = false,
  onOpenFile,
}: {
  block: Block;
  cwd?: string;
  /** False: a line that does not open. */
  expandable?: boolean;
  onOpenFile?: OpenFileFn;
}) {
  const [open, setOpen] = useState(false);
  // The text mounts on first open and stays mounted.
  const [opened, setOpened] = useState(false);
  return (
    <Collapsible
      open={expandable && open}
      onOpenChange={(next) => {
        if (next) setOpened(true);
        setOpen(next);
      }}
      className="min-w-0"
    >
      <div
        data-slot="thought-row"
        className="relative w-fit max-w-full text-muted-foreground has-[>button:focus-visible]:text-foreground has-[>button:hover]:text-foreground"
      >
        <div aria-hidden={expandable || undefined} className={ROW}>
          <Sparkles className="me-1 size-3.5 shrink-0" />
          <span className="truncate">Thought</span>
          {expandable ? (
            <ChevronRight
              className={cn(
                "ms-1 size-3 shrink-0 transition-transform duration-(--dur-base) ease-(--ease-out) motion-reduce:transition-none",
                open && "rotate-90",
              )}
            />
          ) : null}
        </div>
        {expandable ? (
          <CollapsibleTrigger
            aria-label="Thought"
            className="absolute inset-0 rounded-md"
          />
        ) : null}
      </div>
      {expandable ? (
        <CollapsibleContent keepMounted={opened}>
          <div className="min-w-0 pb-2 pl-5.5">
            {opened ? (
              <AgentMarkdown className="agent-reasoning" size="prose" text={block.text} cwd={cwd} onOpenFile={onOpenFile} />
            ) : null}
          </div>
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
}
