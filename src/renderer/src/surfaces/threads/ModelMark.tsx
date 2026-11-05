import type { ReactNode } from "react";
import { HarnessIcon } from "../../chrome/HarnessIcon";
import { HostGlyph } from "../../chrome/HostGlyph";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { cn } from "../../lib/cn";
import { asHarness } from "../../lib/tcserver/store";
import type { SessionMeta } from "../../lib/tcserver/types";
import { effortWord } from "../../lib/models";
import { HARNESS_TITLE } from "../../lib/session";
import { modelLabel, modelVendor } from "../../lib/threads/agents";

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

/** The model's name beside its provider's mark: the mark already says
 *  Claude. "" when the meta names no model or no provider. */
export function modelMarkName(provider: string | null | undefined, model: string | null | undefined): string {
  const name = modelLabel(provider, model);
  return provider && asHarness(provider) === "claude" ? name.replace(/^Claude\s+/, "") : name;
}

/** The mark's tooltip: "Claude Opus 5.5, high effort, 1M context", after
 *  `lead` when given ("Reviewer, Claude Opus 5.5, …"). A vendor's model
 *  names its maker and the harness its mark gave way to: "Meta Muse Wonder
 *  1.0 on Codex, high effort". */
export function modelMarkTip(meta: Partial<Pick<SessionMeta, "provider" | "model" | "reasoning" | "context1m">>, lead?: string): string {
  const effort = meta.reasoning ? `${effortWord(meta.reasoning).toLowerCase()} effort` : null;
  const label = modelLabel(meta.provider, meta.model);
  const name =
    meta.provider && modelVendor(meta.provider, meta.model) === "meta" ? `Meta ${label} on ${HARNESS_TITLE[asHarness(meta.provider)]}` : label;
  return [lead || null, name, effort, meta.context1m ? "1M context" : null].filter(Boolean).join(", ");
}

/** The provider's mark and the model at line one's end, and with `effort`
 *  the effort in the composer's words after it ("Opus 5.5 High"): one muted
 *  12px colour, the logo 6px from the name and the effort 4px after it.
 *  The full model, effort and context are its tooltip, the uncut form a
 *  narrow row's hidden name and effort fall back on. The row's title gives
 *  its width up first (the caller's `shrink-[1000]`); then the name
 *  truncates, and the effort never does. It gives way to the row's actions
 *  on hover and focus. `className` adds to the mark's own classes (the
 *  Agents row's wait), `nameClassName` and `effortClassName` to the name's
 *  and the effort's (a narrow row keeps the mark alone). */
export function ModelMark({
  meta,
  lead,
  effort = false,
  className,
  nameClassName,
  effortClassName,
}: {
  meta: Partial<Pick<SessionMeta, "provider" | "model" | "reasoning" | "context1m">>;
  lead?: string;
  effort?: boolean;
  className?: string;
  nameClassName?: string;
  effortClassName?: string;
}) {
  // A stand-in for a child its host has not described yet names no model: no mark, rather than a wrong one.
  if (!meta.provider || !meta.model) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "flex min-w-0 shrink items-center gap-1.5 overflow-hidden text-xs whitespace-nowrap text-muted-foreground transition-opacity duration-(--dur-fast) group-focus-within:opacity-0 group-hover:opacity-0 motion-reduce:transition-none",
              className,
            )}
            data-model
          />
        }
      >
        <HarnessIcon harness={modelVendor(meta.provider, meta.model) ?? asHarness(meta.provider)} className="size-3 shrink-0" />
        <span className={cn("min-w-0 truncate", nameClassName)} data-model-name>
          {modelMarkName(meta.provider, meta.model)}
        </span>
        {/* 4px after the name: the mark's 6px gap less 2px, so a hidden name and effort leave the logo alone with no gap. */}
        {effort && meta.reasoning ? (
          <span className={cn("-ml-0.5 shrink-0 whitespace-nowrap", effortClassName)} data-model-effort>
            {effortWord(meta.reasoning)}
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipContent>{modelMarkTip(meta, lead)}</TooltipContent>
    </Tooltip>
  );
}
