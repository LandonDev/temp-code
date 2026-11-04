import type { ReactNode } from "react";
import { HarnessIcon } from "../../chrome/HarnessIcon";
import { HostGlyph } from "../../chrome/HostGlyph";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { cn } from "../../lib/cn";
import { asHarness } from "../../lib/tcserver/store";
import type { SessionMeta } from "../../lib/tcserver/types";
import { modelLabel } from "../../lib/threads/agents";

/**
 * The provider's mark and the model a thread runs on, shared by the master
 * board's rows and the right panel's Agents rows, and the host's glyph as
 * a render function both rows take so their views read no store.
 */

/** The host's glyph for a thread, as a render function so the view itself reads no store. */
export type HostGlyphOf = (environmentId: string, title?: string) => ReactNode;

/** The store's host glyph: nothing with one host. */
export const storeHostGlyph: HostGlyphOf = (environmentId, title) => (
  <HostGlyph environmentId={environmentId} title={title} className="shrink-0" />
);

/** How the model mark names effort and context in its tooltip. */
const EFFORT_WORD: Record<string, string> = { low: "low", medium: "medium", high: "high", xhigh: "extra high", max: "max", ultra: "ultra" };

/** The model's name beside its provider's mark: the mark already says Claude. */
export function modelMarkName(provider: string, model: string): string {
  const name = modelLabel(provider, model);
  return asHarness(provider) === "claude" ? name.replace(/^Claude\s+/, "") : name;
}

/** The mark's tooltip: "Claude Opus 5.5, high effort, 1M context", after
 *  `lead` when given ("Reviewer, Claude Opus 5.5, …"). */
export function modelMarkTip(meta: Pick<SessionMeta, "provider" | "model" | "reasoning" | "context1m">, lead?: string): string {
  const effort = meta.reasoning ? `${EFFORT_WORD[meta.reasoning] ?? meta.reasoning} effort` : null;
  return [lead || null, modelLabel(meta.provider, meta.model), effort, meta.context1m ? "1M context" : null].filter(Boolean).join(", ");
}

/** The provider's mark and the model at line one's end, its effort and
 *  context in its tooltip. Secondary, so in a narrow row it gives its
 *  width up before the title does (it shrinks a thousand times faster and
 *  clips), and it gives way to the row's actions on hover and focus.
 *  `className` adds to the mark's own classes (the Agents row's wait),
 *  `nameClassName` to the name's (a narrow row keeps the mark alone). */
export function ModelMark({
  meta,
  lead,
  className,
  nameClassName,
}: {
  meta: Pick<SessionMeta, "provider" | "model" | "reasoning" | "context1m">;
  lead?: string;
  className?: string;
  nameClassName?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "flex min-w-0 shrink-[1000] items-center gap-1.5 overflow-hidden text-xs whitespace-nowrap text-muted-foreground transition-opacity duration-(--dur-fast) group-focus-within:opacity-0 group-hover:opacity-0 motion-reduce:transition-none",
              className,
            )}
            data-model
          />
        }
      >
        <HarnessIcon harness={asHarness(meta.provider)} className="size-3 shrink-0" />
        <span className={cn("min-w-0 truncate", nameClassName)}>{modelMarkName(meta.provider, meta.model)}</span>
      </TooltipTrigger>
      <TooltipContent>{modelMarkTip(meta, lead)}</TooltipContent>
    </Tooltip>
  );
}
