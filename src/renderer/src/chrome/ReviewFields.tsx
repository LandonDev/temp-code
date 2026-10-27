import { useEffect, useState } from "react";
import type { ReviewSettings } from "@server/shared/review";
import { registry } from "../lib/connection";
import type { HarnessId } from "../lib/session";
import { EFFORT_LABELS, effortLadder, type Reasoning } from "../lib/tcserver/defaults";
import { resolveModel } from "../lib/models";
import { useRulesScope } from "../lib/tcserver/rules";
import { parseReviewScope, reviewerModel, reviewerModelOptions, type ReviewScope } from "../lib/reviewScope";

export { reviewSummary, type ReviewScope } from "../lib/reviewScope";
import { ChoiceSelect } from "../components/choice-select";
import { PageRow } from "../components/page";
import { SettingSwitch } from "../components/setting-switch";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";

/**
 * Review before merge (shared/review.ts): the fields, shared by the global
 * Settings › Reviews page and the project dialog's override. Stored whole
 * per scope (`review.set`): a project either follows the global set or
 * carries its own.
 */

/** The harnesses a reviewer can run in: the ones that reach report_findings. */
const REVIEWER_PROVIDERS: HarnessId[] = ["codex", "claude"];

export const BLOCK_OPTIONS: { value: ReviewSettings["blockOn"]; label: string }[] = [
  { value: "confirmed", label: "Confirmed defects" },
  { value: "any", label: "Any finding" },
];

const COPY = {
  before: { label: "Review before merge" },
  model: { label: "Reviewer", hint: "Models the orchestration rules approve." },
  blockOn: { label: "Hold the merge on", hint: "Confirmed means the reviewer verified it." },
  minutes: { label: "Time limit", hint: "Past it the merge goes ahead." },
};

/** Four rows standing in for the fields while `review.get` answers. */
export function ReviewSkeleton() {
  return (
    <div data-testid="review-skeleton" aria-hidden className="flex flex-col">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-3 py-3">
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3 w-48" />
          </div>
          <Skeleton className="h-7 w-28" />
        </div>
      ))}
    </div>
  );
}

export async function loadReviewScope(environmentId: string, projectId: string | null): Promise<ReviewScope> {
  const raw = await registry.linkOf(environmentId).request("review.get", { projectId });
  return parseReviewScope(raw);
}

export async function saveReviewSettings(
  environmentId: string,
  projectId: string | null,
  settings: ReviewSettings | null,
): Promise<void> {
  await registry.linkOf(environmentId).request("review.set", { projectId, settings });
}

export function ReviewFields({
  value,
  onChange,
  environmentId,
  compact = false,
}: {
  value: ReviewSettings;
  onChange: (next: ReviewSettings) => void;
  environmentId: string;
  /** The project sheet: the same rows without their hints. */
  compact?: boolean;
}) {
  const { scope } = useRulesScope(environmentId, null);
  const rules = scope?.rules;
  const model = reviewerModel(value, environmentId);
  const ladder = model ? effortLadder(model) : [];
  const current = model ? (model.nativeId ?? model.id) : value.model;
  // One list over every reviewer provider; a value is `provider:model`.
  const options = REVIEWER_PROVIDERS.flatMap((provider) =>
    reviewerModelOptions(provider, environmentId, rules).map((o) => ({ value: `${provider}:${o.value}`, label: o.label })),
  );
  const chosen = `${value.provider}:${current}`;
  const modelOptions = options.some((o) => o.value === chosen)
    ? options
    : [{ value: chosen, label: model ? `${model.name} (not approved)` : current }, ...options];
  const set = (patch: Partial<ReviewSettings>) => {
    const next = { ...value, ...patch };
    const m = resolveModel(next.provider as HarnessId, next.model || undefined, environmentId);
    const steps = effortLadder(m);
    if (steps.length && !steps.includes(next.reasoning as Reasoning)) {
      const effort = m.settings?.find((s) => s.id === "effort");
      next.reasoning = (steps.includes(effort?.value as Reasoning) ? effort!.value : steps[0]) as ReviewSettings["reasoning"];
    }
    onChange(next);
  };
  const [minutes, setMinutes] = useState(String(value.maxMinutes));
  useEffect(() => setMinutes(String(value.maxMinutes)), [value.maxMinutes]);
  const commitMinutes = () => {
    const n = Math.round(Number(minutes));
    if (Number.isFinite(n) && n >= 1 && n <= 240) set({ maxMinutes: n });
    else setMinutes(String(value.maxMinutes));
  };
  const hint = (text: string) => (compact ? undefined : text);

  return (
    <div data-slot="review-fields" className="flex flex-col">
      <PageRow title={COPY.before.label}>
        <SettingSwitch label={COPY.before.label} on={value.beforeMerge} onChange={(beforeMerge) => set({ beforeMerge })} />
      </PageRow>
      {value.beforeMerge ? (
        <>
          <PageRow title={COPY.model.label} description={hint(COPY.model.hint)}>
            <ChoiceSelect
              label={COPY.model.label}
              value={chosen}
              options={modelOptions}
              onChange={(next) => {
                const at = next.indexOf(":");
                set({ provider: next.slice(0, at) as ReviewSettings["provider"], model: next.slice(at + 1) });
              }}
            />
          </PageRow>
          {ladder.length > 1 ? (
            <PageRow title="Effort">
              <ChoiceSelect
                label="Effort"
                value={value.reasoning}
                options={ladder.map((level) => ({ value: level, label: EFFORT_LABELS[level] }))}
                onChange={(reasoning) => set({ reasoning: reasoning as ReviewSettings["reasoning"] })}
              />
            </PageRow>
          ) : null}
          <PageRow title={COPY.blockOn.label} description={hint(COPY.blockOn.hint)}>
            <ChoiceSelect label={COPY.blockOn.label} value={value.blockOn} options={BLOCK_OPTIONS} onChange={(blockOn) => set({ blockOn })} />
          </PageRow>
          <PageRow title={COPY.minutes.label} description={hint(COPY.minutes.hint)}>
            <span className="flex items-center gap-2 text-[12px] text-muted-foreground">
              <Input
                aria-label={COPY.minutes.label}
                inputMode="numeric"
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
                onBlur={commitMinutes}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
                className="w-16 text-right tabular-nums"
              />
              min
            </span>
          </PageRow>
        </>
      ) : null}
    </div>
  );
}
