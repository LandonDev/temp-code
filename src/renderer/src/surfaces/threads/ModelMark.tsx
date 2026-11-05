import type { ReactNode } from "react";
import { supportsContext1m } from "@server/shared/catalog";
import { HarnessIcon } from "../../chrome/HarnessIcon";
import { HostGlyph } from "../../chrome/HostGlyph";
import { yields } from "../../components/ui/reveal";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { cn } from "../../lib/cn";
import { asHarness, pickerModelId } from "../../lib/tcserver/store";
import type { SessionMeta } from "../../lib/tcserver/types";
import { effortWord, findModel } from "../../lib/models";
import { HARNESS_TITLE } from "../../lib/session";
import { modelLabel, modelVendor } from "../../lib/threads/agents";

/**
 * The provider's mark and the model a thread runs on: `ModelMark` at the end
 * of a master board row's first line, `ModelLine` as the last line of a right
 * panel Agents row; and the host's glyph as a render function both rows take
 * so their views read no store.
 */

type ModelMeta = Partial<Pick<SessionMeta, "provider" | "model" | "reasoning" | "context1m" | "context">>;

/** The host's glyph for a thread, as a render function so the view itself reads no store. */
export type HostGlyphOf = (environmentId: string, title?: string) => ReactNode;

/** The store's host glyph: nothing with one host. */
export const storeHostGlyph: HostGlyphOf = (environmentId, title) => (
  <HostGlyph environmentId={environmentId} title={title} className="shrink-0" />
);

/** A context window in the composer's words: "1M", "200k", "500k". */
export function contextWindowWord(tokens: number): string {
  return tokens >= 1_000_000 ? `${Math.round(tokens / 1_000_000)}M` : `${Math.round(tokens / 1000)}k`;
}

/** The window a thread runs with, in the composer's words: a Claude model
 *  that offers 1M says "1M" or "200k" by the thread's `context1m`; any
 *  other model its catalog window, else the window its harness reported;
 *  "" when nothing names one. */
export function modelContextWord(
  meta: ModelMeta,
): string {
  if (!meta.provider || !meta.model) return "";
  const harness = asHarness(meta.provider);
  if (harness === "claude" && supportsContext1m("claude", meta.model)) return meta.context1m ? "1M" : "200k";
  const window = findModel(pickerModelId(harness, meta.model))?.contextWindow ?? meta.context?.window;
  return window && window > 0 ? contextWindowWord(window) : "";
}

/** The model's name beside its provider's mark: the mark already says
 *  Claude. "" when the meta names no model or no provider. */
export function modelMarkName(provider: string | null | undefined, model: string | null | undefined): string {
  const name = modelLabel(provider, model);
  return provider && asHarness(provider) === "claude" ? name.replace(/^Claude\s+/, "") : name;
}

/** The mark's tooltip: "Claude Opus 5.5, high effort, 1M context", after
 *  `lead` when given ("Reviewer, Claude Opus 5.5, …"). A vendor's model
 *  names its maker and the harness its mark gave way to: "Meta Muse Wonder
 *  1.0 on Codex, high effort". The context is `context` when given (the
 *  model line's word, "200k"), else "1M" for a thread on the 1M window. */
export function modelMarkTip(meta: ModelMeta, lead?: string, context?: string): string {
  const effort = meta.reasoning ? `${effortWord(meta.reasoning).toLowerCase()} effort` : null;
  const label = modelLabel(meta.provider, meta.model);
  const name =
    meta.provider && modelVendor(meta.provider, meta.model) === "meta" ? `Meta ${label} on ${HARNESS_TITLE[asHarness(meta.provider)]}` : label;
  const window = context || (meta.context1m ? "1M" : "");
  return [lead || null, name, effort, window ? `${window} context` : null].filter(Boolean).join(", ");
}

/** The provider's mark and the model at line one's end, and with `effort`
 *  the effort in the composer's words after it ("Opus 5.5 High"): one muted
 *  12px colour, the logo 6px from the name and the effort 4px after it.
 *  The full model, effort and context are its tooltip, the uncut form a
 *  narrow row's hidden name and effort fall back on. The row's title gives
 *  its width up first (the caller's `shrink-[1000]`); then the name
 *  truncates, and the effort never does. It gives way to the row's actions
 *  on their own timing (`yields`: after `--delay-hover` on hover, at once on
 *  keyboard focus), so the two cross over together. `className` adds to the mark's own classes (the
 *  Agents row's wait), `nameClassName` and `effortClassName` to the name's
 *  and the effort's (a narrow row keeps the mark alone). */
const YIELDS = yields("");

export function ModelMark({
  meta,
  lead,
  effort = false,
  className,
  nameClassName,
  effortClassName,
}: {
  meta: ModelMeta;
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
              "flex min-w-0 shrink items-center gap-1.5 overflow-hidden text-xs whitespace-nowrap text-muted-foreground",
              YIELDS,
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

/** A right panel Agents row's last line: the provider's mark, the model,
 *  the effort in the composer's words and the context window ("Opus 5.5
 *  High 1M"), one muted 12px run, each part 4px from the next, never joined
 *  by a dot. Only the model's name truncates, and only when the line is
 *  narrower than the run; the effort and the window never do. It stays put
 *  under the row's hover actions. Its tooltip is `modelMarkTip` with the
 *  role first and the window's word. `trailing` ends the line (a settled
 *  row's time). */
export function ModelLine({
  meta,
  lead,
  trailing,
  tip = true,
  className,
}: {
  meta: ModelMeta;
  lead?: string;
  trailing?: ReactNode;
  /** The mark's own tooltip; false where the row's tooltip says the model (an Agents row). */
  tip?: boolean;
  className?: string;
}) {
  const known = !!meta.provider && !!meta.model;
  if (!known && !trailing) return null;
  const context = modelContextWord(meta);
  const mark = known ? (
    <>
      <HarnessIcon harness={modelVendor(meta.provider, meta.model) ?? asHarness(meta.provider!)} className="size-3 shrink-0" />
      <span className="min-w-0 truncate" data-model-name>
        {modelMarkName(meta.provider, meta.model)}
      </span>
      {meta.reasoning ? (
        <span className="shrink-0" data-model-effort>
          {effortWord(meta.reasoning)}
        </span>
      ) : null}
      {context ? (
        <span className="shrink-0 tabular-nums" data-model-context>
          {context}
        </span>
      ) : null}
    </>
  ) : null;
  return (
    <span className={cn("flex h-4 min-w-0 items-center gap-1 text-xs leading-4 whitespace-nowrap text-muted-foreground", className)} data-model-line>
      {known ? (
        tip ? (
          <Tooltip>
            <TooltipTrigger render={<span className="flex min-w-0 items-center gap-1" data-model />}>{mark}</TooltipTrigger>
            <TooltipContent>{modelMarkTip(meta, lead, context)}</TooltipContent>
          </Tooltip>
        ) : (
          <span className="flex min-w-0 items-center gap-1" data-model>
            {mark}
          </span>
        )
      ) : null}
      {trailing ? <span className="ms-auto shrink-0 tabular-nums">{trailing}</span> : null}
    </span>
  );
}
