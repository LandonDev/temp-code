import { useState, type MouseEvent } from "react";
import { ChevronRight } from "../chrome/icons";
import { Collapsible, CollapsibleContent, CollapsibleTrigger, DISCLOSURE_CHEVRON } from "../components/ui/collapsible";
import { cn } from "../lib/cn";

/**
 * The project rules a thread's first message opened with, folded to one
 * line above the brief the person wrote: "Project rules 212 words" (the
 * lead medium, the count regular), its
 * chevron trailing as every disclosure's does and its text ending on the
 * bubble's right edge (the row's 8px padding hangs past it). The
 * caret opens the text in place; the bubble's own clamp toggle never sees
 * the click. The thread keeps the text it started with, so this is a
 * record, not an editor.
 */
export function PreambleRow({ text, words }: { text: string; words: number }) {
  const [open, setOpen] = useState(false);
  const stop = (e: MouseEvent) => e.stopPropagation();
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mb-1 flex flex-col" data-preamble-row>
      <CollapsibleTrigger
        onClick={stop}
        className="-mr-2 flex h-6 w-fit items-center gap-1 self-end rounded-md px-2 text-xs text-muted-foreground hover:text-foreground"
      >
        {/* The lead in medium, its count regular: two facts part by weight, never by space alone. */}
        <span className="font-medium">Project rules</span>
        <span className="tabular-nums">
          {words} word{words === 1 ? "" : "s"}
        </span>
        <ChevronRight aria-hidden className={cn("ms-1 size-3 shrink-0", DISCLOSURE_CHEVRON, open && "rotate-90")} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre onClick={stop} className="min-w-0 whitespace-pre-wrap break-words pt-1 font-sans text-[13px] leading-5 text-muted-foreground">
          {text}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}
