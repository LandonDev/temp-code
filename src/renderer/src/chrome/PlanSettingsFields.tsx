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
} from "../lib/tcserver/plans";
import { ChoiceSelect } from "../components/choice-select";
import { PageRow, PageSection } from "../components/page";
import { Button } from "../components/ui/button";
import { SettingSwitch } from "../components/setting-switch";

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
  const size = compact ? "sm" : "default";
  const hint = (text: string) => (compact ? undefined : text);
  return (
    <>
      <PageRow
        title="Start the build on its own"
        description={hint("When the planner marks its plan complete, the implementation thread starts without a click.")}
      >
        <SettingSwitch label="Start the build on its own" on={value.autoImplement} onChange={(on) => set({ autoImplement: on })} />
      </PageRow>
      <PageRow
        title="Archive the plan after start"
        description={hint("The planning thread leaves the list once its build runs; the plan file and the link stay.")}
      >
        <SettingSwitch label="Archive the plan after start" on={value.archiveAfterStart} onChange={(on) => set({ archiveAfterStart: on })} />
      </PageRow>
      <PageRow title="Build model" description={hint("The planning thread's own model unless fixed here.")}>
        <ChoiceSelect
          label="Build model"
          size={size}
          value={value.implementModel}
          options={modelOptions}
          onChange={(implementModel) => set({ implementModel })}
        />
      </PageRow>
      <PageRow title="Build effort" description={hint("The planning thread's own effort unless fixed here.")}>
        <ChoiceSelect
          label="Build effort"
          size={size}
          value={value.implementReasoning}
          options={reasoningOptions}
          onChange={(implementReasoning) => set({ implementReasoning: implementReasoning as PlanSettings["implementReasoning"] })}
        />
      </PageRow>
      <PageRow
        title="Build context"
        description={hint("The planning thread's own window unless fixed; 1M applies only to models that offer it.")}
      >
        <ChoiceSelect
          label="Build context"
          size={size}
          value={value.implementContext}
          options={[SAME, { value: "1m", label: "1M" }, { value: "200k", label: "200k" }]}
          onChange={(implementContext) => set({ implementContext: implementContext as PlanSettings["implementContext"] })}
        />
      </PageRow>
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
    <PageSection
      title="Plans"
      action={
        shown.overridden ? (
          <Button variant="ghost" size="sm" onClick={() => save(null)}>
            Reset
          </Button>
        ) : null
      }
    >
      <PlanSettingsFields value={shown.settings} onChange={save} environmentId={environmentId} />
      {error ? <p className="pt-2 text-xs text-destructive">{error}</p> : null}
    </PageSection>
  );
}
