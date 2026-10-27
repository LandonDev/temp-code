import { useState, type MouseEvent } from "react";
import { ChevronRight } from "../chrome/icons";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { cn } from "../lib/cn";

/**
 * The project rules a thread's first message opened with, folded to one
 * line above the brief the person wrote: "Project rules  212 words". The
 * caret opens the text in place; the bubble's own clamp toggle never sees
 * the click. The thread keeps the text it started with, so this is a
 * record, not an editor.
 */
export function PreambleRow({ text, words }: { text: string; words: number }) {
  const [open, setOpen] = useState(false);
  const stop = (e: MouseEvent) => e.stopPropagation();
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mb-1.5 flex flex-col" data-preamble-row>
      <CollapsibleTrigger
        onClick={stop}
        className="-ml-2 flex w-fit items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight
          className={cn(
            "size-3 shrink-0 transition-transform duration-(--dur-fast) ease-(--ease-out) motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        <span>Project rules</span>
        <span className="tabular-nums">
          {words} word{words === 1 ? "" : "s"}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre onClick={stop} className="min-w-0 whitespace-pre-wrap break-words pt-1 font-sans text-[13px] leading-5 text-muted-foreground">
          {text}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}
