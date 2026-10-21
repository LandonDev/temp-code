import {
  DEFAULT_REVIEW_SETTINGS,
  ReviewSettingsSchema,
  type ReviewSettings,
} from "@server/shared/review";
import { modelApproved } from "@server/shared/rules";
import type { HarnessId } from "./session";
import { modelsFor, resolveModel } from "./models";

/** Review-before-merge settings as the renderer reads them (chrome/ReviewFields.tsx edits them). */

export type ReviewScope = {
  /** the scope's own set, null when it follows the one above */
  override: ReviewSettings | null;
  global: ReviewSettings | null;
  settings: ReviewSettings;
  source: "project" | "global" | "default";
};

export function parseReviewScope(raw: unknown): ReviewScope {
  const r = (raw ?? {}) as Record<string, unknown>;
  const parse = (v: unknown): ReviewSettings | null => {
    const p = ReviewSettingsSchema.safeParse(v);
    return p.success ? p.data : null;
  };
  const override = parse(r.override);
  const global = parse(r.global);
  return {
    override,
    global,
    settings: parse(r.settings) ?? override ?? global ?? DEFAULT_REVIEW_SETTINGS,
    source: r.source === "project" || r.source === "global" ? r.source : "default",
  };
}

/** The approved, runnable models of a provider, keyed by the native id the server stores. */
export function reviewerModelOptions(
  provider: string,
  environmentId: string,
  rules: Parameters<typeof modelApproved>[0] | undefined,
): { value: string; label: string }[] {
  return modelsFor(provider as HarnessId, environmentId)
    .map((m) => ({ value: m.nativeId ?? m.id, label: m.name }))
    .filter((o) => !rules || modelApproved(rules, provider as never, o.value));
}

/** The catalog row a set names, or null when this harness's catalog has
 *  not arrived (resolveModel would answer another harness's default). */
export function reviewerModel(s: Pick<ReviewSettings, "provider" | "model">, environmentId?: string) {
  const model = resolveModel(s.provider as HarnessId, s.model || undefined, environmentId);
  return model.harness === s.provider ? model : null;
}

export function reviewSummary(s: ReviewSettings, environmentId?: string): string {
  if (!s.beforeMerge) return "Off";
  const model = reviewerModel(s, environmentId)?.name ?? s.model;
  return `${model} · ${s.blockOn === "any" ? "any finding" : "confirmed"} · ${s.maxMinutes} min`;
}

