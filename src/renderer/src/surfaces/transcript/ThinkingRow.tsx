// A9 (thinking): a settled thought, in a group opened by hand.
import { Sparkles } from "../../chrome/icons";
import { cn } from "../../lib/cn";
import { type Block } from "../../lib/session";
import type { OpenFileFn } from "../../lib/search";
import { AgentMarkdown } from "../AgentMarkdown";
import { GLYPH_SLOT } from "./stepLine";

/**
 * A thought that settled, as one entry of a group a person opened: the
 * whole thought, readable at once, in the reasoning column's type (14px on
 * 22px lines, muted: `.agent-reasoning`) on the step grid's text column,
 * the thought glyph on its first line where a step's glyph sits. No word
 * to click, no chevron and no duration: the live seconds were the working
 * line's, and a span beside a paragraph is noise. It mounts settled (no
 * fade per sentence, no shimmer); the group's own fold carries it. A thought
 * streaming is the turn's working line, never a row (WorkingLine.tsx), and a
 * group the person did not open shows no thought at all (ActionGroup.tsx).
 * Uncapped: the group is already the person's own open.
 */
export function ActivityThinkingRow({ block, cwd, onOpenFile }: { block: Block; cwd?: string; onOpenFile?: OpenFileFn }) {
  return (
    <div
      data-slot="thought-row"
      className={cn(
        "flex min-h-7 min-w-0 items-start gap-1 py-1 font-sans in-data-[table]:min-h-8 in-data-[table]:px-3 in-data-[table]:py-1.5",
      )}
    >
      {/* The 14px glyph centred on the first 22px line. */}
      <span className={cn(GLYPH_SLOT, "mt-1")}>
        <Sparkles aria-hidden className="size-3.5" />
      </span>
      <div data-thought-text className="min-w-0 flex-1">
        <AgentMarkdown className="agent-reasoning" size="prose" text={block.text} cwd={cwd} onOpenFile={onOpenFile} />
      </div>
    </div>
  );
}
