import { useState } from "react";
import type { PlanSettings } from "@server/shared/plans";
import { registry } from "../lib/connection";
import { HARNESS_LABEL } from "../lib/session";
import { allModels, findModel, nativeModelId } from "../lib/models";
import { EFFORT_LABELS, REASONING_LEVELS, effortLadder } from "../lib/tcserver/defaults";
import {
  BUILT_IN_PLAN_SCOPE,
  savePlanSettings,
  usePlanSettings,
  type PlanScope,
} from "../lib/tcserver/plans";
import { Heading, Row, SecondaryButton, Select, Toggle } from "../surfaces/settingsBits";

/**
 * What happens when a plan is complete (plans.ts): whether the build starts
 * on its own, whether the planning thread is archived once it has, and the
 * model, effort and context window the build runs with — each "same as
 * the plan" unless fixed. Global per host, overridable per project.
 */

type Change = (next: PlanSettings) => void;

const SAME = { value: "", label: "Same as the plan" };

export function PlanSettingsFields({
  value,
  onChange,
  environmentId,
  compact = false,
}: {
  value: PlanSettings;
  onChange: Change;
  environmentId?: string;
  compact?: boolean;
}) {
  const set = (patch: Partial<PlanSettings>) => onChange({ ...value, ...patch });
  const fixed = value.implementModel ? findModel(value.implementModel) : undefined;
  const ladder = fixed ? effortLadder(fixed) : [...REASONING_LEVELS];
  const models = allModels(environmentId);
  const known = !value.implementModel || models.some((m) => nativeModelId(m) === value.implementModel);
  const modelOptions = [
    SAME,
    ...models.map((m) => ({ value: nativeModelId(m), label: `${HARNESS_LABEL[m.harness]} · ${m.name}` })),
    ...(known ? [] : [{ value: value.implementModel, label: value.implementModel }]),
  ];
  const reasoningOptions = [
    SAME,
    ...ladder.map((level) => ({ value: level, label: EFFORT_LABELS[level] })),
    ...(value.implementReasoning && !ladder.includes(value.implementReasoning)
      ? [{ value: value.implementReasoning, label: EFFORT_LABELS[value.implementReasoning] }]
      : []),
  ];
  const selectClass = compact ? "max-w-full" : undefined;
  return (
    <>
      <Row
        label="Start the build on its own"
        description={compact ? undefined : "When the planner marks its plan complete, the implementation thread starts without a click."}
      >
        <Toggle label="Start the build on its own" on={value.autoImplement} onChange={(on) => set({ autoImplement: on })} />
      </Row>
      <Row
        label="Archive the plan after start"
        description={compact ? undefined : "The planning thread leaves the list once its build is running; the plan file and the link stay."}
      >
        <Toggle label="Archive the plan after start" on={value.archiveAfterStart} onChange={(on) => set({ archiveAfterStart: on })} />
      </Row>
      <Row label="Build model" description={compact ? undefined : "The planning thread's own model unless fixed here."}>
        <Select
          label="Build model"
          value={value.implementModel}
          options={modelOptions}
          className={selectClass}
          onChange={(implementModel) => set({ implementModel })}
        />
      </Row>
      <Row label="Build effort" description={compact ? undefined : "The planning thread's own effort unless fixed here."}>
        <Select
          label="Build effort"
          value={value.implementReasoning}
          options={reasoningOptions}
          className={selectClass}
          onChange={(implementReasoning) => set({ implementReasoning: implementReasoning as PlanSettings["implementReasoning"] })}
        />
      </Row>
      <Row label="Build context" description={compact ? undefined : "The planning thread's own window unless fixed; 1M applies only to models that offer it."}>
        <Select
          label="Build context"
          value={value.implementContext}
          options={[SAME, { value: "1m", label: "1M" }, { value: "200k", label: "200k" }]}
          className={selectClass}
          onChange={(implementContext) => set({ implementContext: implementContext as PlanSettings["implementContext"] })}
        />
      </Row>
    </>
  );
}

export function planSettingsSummary(s: PlanSettings): string {
  const parts = [s.autoImplement ? "Auto-start" : "Start by hand"];
  if (s.implementModel) parts.push(findModel(s.implementModel)?.name ?? s.implementModel);
  if (s.implementReasoning) parts.push(EFFORT_LABELS[s.implementReasoning]);
  if (s.implementContext) parts.push(s.implementContext === "1m" ? "1M" : "200k");
  return parts.join(" · ");
}

function scopeHint(scope: PlanScope): string {
  return scope.overridden
    ? "Applied wherever a project has no override of its own."
    : "The built-in defaults; any change is kept here and applies wherever a project has no override.";
}

/** The global group on the Settings page: self-loading, saves on every change. */
export function PlanSettingsEditor() {
  const environmentId = registry.primary().environmentId;
  const scope = usePlanSettings(environmentId, null);
  const [error, setError] = useState<string | null>(null);
  const save = (next: PlanSettings | null) => {
    setError(null);
    savePlanSettings(environmentId, null, next).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };
  const shown = scope ?? BUILT_IN_PLAN_SCOPE;
  return (
    <section>
      <div className="flex items-end justify-between gap-4">
        <Heading title="Plans" />
        {shown.overridden ? (
          <span className="pb-1">
            <SecondaryButton onClick={() => save(null)}>Reset</SecondaryButton>
          </span>
        ) : null}
      </div>
      <p className="pb-2 text-[12px] leading-relaxed text-content/40">{scopeHint(shown)}</p>
      <PlanSettingsFields value={shown.settings} onChange={save} environmentId={environmentId} />
      {error ? <p className="pt-2 text-[12px] text-danger">{error}</p> : null}
    </section>
  );
}
