// A9 (thinking): a thinking row in a group.
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { ChevronRight, Sparkles } from "../../chrome/icons";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../components/ui/collapsible";
import { StreamingText } from "../../components/ui/streaming-text";
import { TextPulse } from "../../components/ui/text-pulse";
import { cn } from "../../lib/cn";
import { FADE_OUT } from "../../lib/ease";
import { useHeldWord } from "../../lib/heldWord";
import { type Block } from "../../lib/session";
import type { OpenFileFn } from "../../lib/search";
import { SwapText } from "../../motion/SwapText";
import { AgentMarkdown } from "../AgentMarkdown";
import { latestLine, latestLineKey, thoughtLabel, thoughtMs } from "./thinking";

/** One row of the action list: the 14px glyph slot, then the words. */
const ROW = "flex min-h-7 min-w-0 items-center gap-2 font-sans text-[13px] leading-5";
const GLYPH = <Sparkles className="size-3.5 shrink-0 text-muted-foreground" />;

/**
 * A live turn's tail before its first content: the thinking row's live shape
 * with no sentence yet, so the row that replaces it does not jump. It says
 * the turn's true phase (`tailWord`): Sending until the host echoes the
 * message, then the host's word for the wait, else Thinking. A word stays at
 * least 300 ms once painted; a change swaps the words inside the pulse
 * (`SwapText`: the old lift 3px and fade, the new rise from 3px below).
 */
export function ThinkingTail({ word = "Thinking" }: { word?: string }) {
  const shown = useHeldWord(word);
  return (
    <div aria-label={shown} data-slot="thinking-tail" className={ROW}>
      {GLYPH}
      <TextPulse className="relative shrink-0">
        <SwapText state={shown}>{shown}</SwapText>
      </TextPulse>
    </div>
  );
}

/**
 * A thought, as one row of the paragraph's action list, the same row live
 * and settled. While it streams: "Thinking" pulsing and the newest finished
 * sentence after it, its words fading in (a new sentence whole, a growing one
 * only its new words). When it ends, in place: "Thinking" becomes "Thought
 * for 4s" through `SwapText` with the chevron, and the sentence fades out
 * over --dur-fast. The settled row opens the whole text; reasoning is only
 * read on purpose, and a live row opens nothing.
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

  const live = !!block.streaming;
  const line = live ? latestLine(block.text) : "";
  const label = live ? "Thinking" : thoughtLabel(thoughtMs(block, endTs));
  const opens = !live && expandable;

  // One element tree for both states, so the label swaps and the sentence
  // fades instead of the row remounting. A row that opens lays its trigger
  // over the row: the button is named by the label the row draws.
  return (
    <Collapsible
      open={opens && open}
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
        <div aria-label={live ? "Thinking" : undefined} aria-hidden={opens || undefined} className={ROW}>
          {GLYPH}
          <SwapText
            state={live ? "live" : "settled"}
            className={live ? "shrink-0" : "flex min-w-0 items-center gap-2"}
          >
            {live ? (
              <TextPulse>Thinking</TextPulse>
            ) : (
              <>
                <span className="truncate">{label}</span>
                {expandable ? (
                  <ChevronRight
                    className={cn(
                      "size-3 shrink-0 transition-transform duration-(--dur-base) ease-(--ease-out) motion-reduce:transition-none",
                      open && "rotate-90",
                    )}
                  />
                ) : null}
              </>
            )}
          </SwapText>
          <AnimatePresence initial={false}>
            {line ? (
              <motion.span key="line" data-slot="thought-line" className="flex min-w-0" initial={false} animate={{ opacity: 1 }} exit={FADE_OUT}>
                <StreamingText key={latestLineKey(block.text)} className="min-w-0 truncate text-muted-foreground">
                  {line}
                </StreamingText>
              </motion.span>
            ) : null}
          </AnimatePresence>
        </div>
        {opens ? (
          <CollapsibleTrigger
            aria-label={label}
            className="absolute inset-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        ) : null}
      </div>
      {opens ? (
        <CollapsibleContent keepMounted={opened}>
          <div className="min-w-0 pb-2 pl-5.5">
            {opened ? (
              <AgentMarkdown
                className="agent-reasoning"
                size="prose"
                text={block.text}
                cwd={cwd}
                onOpenFile={onOpenFile}
              />
            ) : null}
          </div>
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
}
