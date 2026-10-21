import { useEffect, useState } from "react";
import type { ReviewSettings } from "@server/shared/review";
import { registry } from "../lib/connection";
import { HARNESS_TITLE, type HarnessId } from "../lib/session";
import { EFFORT_LABELS, effortLadder, type Reasoning } from "../lib/tcserver/defaults";
import { resolveModel } from "../lib/models";
import { useRulesScope } from "../lib/tcserver/rules";
import { parseReviewScope, reviewerModel, reviewerModelOptions, type ReviewScope } from "../lib/reviewScope";

export { reviewSummary, type ReviewScope } from "../lib/reviewScope";
import { Input, Row, Segmented, Select, Toggle } from "../surfaces/settingsBits";

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
  before: {
    label: "Review before merge",
    hint: "An implementation thread's branch is reviewed by a second model before it lands on the project branch.",
  },
  model: { label: "Reviewer", hint: "Models the orchestration rules approve and this machine can run." },
  blockOn: { label: "Hold the merge on", hint: "Confirmed defects the reviewer verified, or anything it reports." },
  minutes: { label: "Time limit", hint: "Past it the merge proceeds and the thread says the review timed out." },
};

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
  /** Stacked, tighter rows for dialogs; the default is a settings page. */
  compact?: boolean;
}) {
  const { scope } = useRulesScope(environmentId, null);
  const rules = scope?.rules;
  const model = reviewerModel(value, environmentId);
  const ladder = model ? effortLadder(model) : [];
  const options = reviewerModelOptions(value.provider, environmentId, rules);
  const current = model ? (model.nativeId ?? model.id) : value.model;
  const modelOptions = options.some((o) => o.value === current)
    ? options
    : [{ value: current, label: model ? `${model.name} (not approved)` : current }, ...options];
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

  const toggle = <Toggle label={COPY.before.label} on={value.beforeMerge} onChange={(beforeMerge) => set({ beforeMerge })} />;
  const provider = (
    <Select
      label="Provider"
      value={value.provider}
      options={REVIEWER_PROVIDERS.map((id) => ({ value: id, label: HARNESS_TITLE[id] }))}
      onChange={(p) => set({ provider: p as ReviewSettings["provider"], model: "" })}
      className={compact ? "max-w-28" : "max-w-32"}
    />
  );
  const modelSelect = (
    <Select label="Model" value={current} options={modelOptions} onChange={(m) => set({ model: m })} className={compact ? "max-w-40" : "max-w-52"} />
  );
  const reasoning =
    ladder.length > 1 ? (
      <Select
        label="Reasoning"
        value={value.reasoning}
        options={ladder.map((level) => ({ value: level, label: EFFORT_LABELS[level] }))}
        onChange={(reasoning) => set({ reasoning: reasoning as ReviewSettings["reasoning"] })}
        className={compact ? "max-w-28" : "max-w-32"}
      />
    ) : null;
  const blockOn = (
    <Segmented label={COPY.blockOn.label} value={value.blockOn} options={BLOCK_OPTIONS} onChange={(blockOn) => set({ blockOn })} />
  );
  const limit = (
    <label className="flex items-center gap-1.5 text-[12px] text-content/50">
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
    </label>
  );

  if (compact) {
    return (
      <div className="flex flex-col gap-2.5">
        <CompactRow {...COPY.before}>{toggle}</CompactRow>
        {value.beforeMerge ? (
          <>
            <CompactRow {...COPY.model}>
              <div className="flex flex-wrap justify-end gap-1.5">
                {provider}
                {modelSelect}
                {reasoning}
              </div>
            </CompactRow>
            <CompactRow {...COPY.blockOn}>{blockOn}</CompactRow>
            <CompactRow {...COPY.minutes}>{limit}</CompactRow>
          </>
        ) : null}
      </div>
    );
  }
  return (
    <>
      <Row label={COPY.before.label} description={COPY.before.hint}>
        {toggle}
      </Row>
      <Row label={COPY.model.label} description={COPY.model.hint}>
        {provider}
        {modelSelect}
        {reasoning}
      </Row>
      <Row label={COPY.blockOn.label} description={COPY.blockOn.hint}>
        {blockOn}
      </Row>
      <Row label={COPY.minutes.label} description={COPY.minutes.hint}>
        {limit}
      </Row>
    </>
  );
}

function CompactRow({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4">
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-medium text-content">{label}</div>
        <div className="text-[11px] leading-4 text-content/40">{hint}</div>
      </div>
      {children}
    </div>
  );
}
