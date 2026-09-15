import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Plus } from "./icons";
import { HarnessIcon } from "./HarnessIcon";
import { GHOST, PRIMARY } from "./ConfirmDialog";
import { Modal } from "./Modal";
import { Heading, Input, Row, Segmented, SecondaryButton, Select, Toggle } from "../surfaces/settingsBits";
import {
  approvedLadder,
  modelApproved,
  moveRoutingRuleUp,
  newRuleId,
  patchModelPolicy,
  removeRoutingRule,
  rulesStore,
  SPAWN_PROVIDERS,
  upsertRoutingRule,
  useRulesScope,
  type ModelPolicy,
  type OrchestrationRules,
  type RoutingRule,
  type RulesCatalog,
  type SpawnProviderId,
} from "../lib/tcserver/rules";
import type { HarnessId } from "../lib/session";
import type { ModelInfo, Reasoning } from "../lib/tcserver/types";
import { MatrixSpinner } from "../surfaces/threads/bits";

/**
 * Structured orchestration rules (server/shared/rules.ts): conduct bounds
 * with real switches, and an ordered routing table mapping kinds of work
 * to an exact provider/model/effort. Changes save immediately — these are
 * settings, not a document. Global scope is the Orchestration settings
 * page; a workspace override (whole-object) is the same page with that
 * workspace picked as the scope.
 */

const EFFORT_LABELS: Record<Reasoning, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

type Delegation = OrchestrationRules["conduct"]["delegation"];

const DELEGATION_OPTIONS: { value: Delegation; label: string }[] = [
  { value: "strict", label: "Strict" },
  { value: "balanced", label: "Balanced" },
  { value: "free", label: "Free" },
];

const DELEGATION_HINTS: Record<Delegation, string> = {
  strict: "Delegates everything; the orchestrator never does the work itself.",
  balanced: "Delegates substantive work; handles trivial glue itself.",
  free: "May work directly whenever that is faster.",
};

const providersOf = (catalog: RulesCatalog | null): SpawnProviderId[] =>
  SPAWN_PROVIDERS.filter((p): p is SpawnProviderId => !!catalog?.[p as SpawnProviderId]);

export function OrchestrationRulesEditor({ workspaceId }: { workspaceId: string | null }) {
  const { scope, catalog } = useRulesScope(workspaceId);
  const [editing, setEditing] = useState<RoutingRule | "new" | null>(null);

  if (!scope) {
    return (
      <div className="flex h-24 items-center justify-center">
        <MatrixSpinner />
      </div>
    );
  }
  const { rules, overridden } = scope;

  // Settings semantics: every change persists immediately.
  const push = (next: OrchestrationRules) => void rulesStore.save(workspaceId, next);
  const patchConduct = (patch: Partial<OrchestrationRules["conduct"]>) =>
    push({ ...rules, conduct: { ...rules.conduct, ...patch } });
  const clearScope = () => void rulesStore.clear(workspaceId);
  const saveRule = (rule: RoutingRule) => {
    push(upsertRoutingRule(rules, rule));
    setEditing(null);
  };
  const deleteRule = (id: string) => {
    push(removeRoutingRule(rules, id));
    setEditing(null);
  };

  const scopeHint = workspaceId
    ? overridden
      ? "This workspace overrides the global rules."
      : "Using the global rules; any change creates a workspace override."
    : "Defaults for every thread that spawns subagents.";

  return (
    <>
      <Section
        title="Conduct"
        hint={scopeHint}
        first
        action={
          !workspaceId || overridden ? (
            <SecondaryButton onClick={clearScope}>
              {workspaceId ? "Remove override" : "Reset"}
            </SecondaryButton>
          ) : null
        }
      >
        <Row label="Delegation" description={DELEGATION_HINTS[rules.conduct.delegation]}>
          <Segmented
            label="Delegation"
            value={rules.conduct.delegation}
            options={DELEGATION_OPTIONS}
            onChange={(delegation) => patchConduct({ delegation })}
          />
        </Row>
        <Row label="Edit files itself" description="Off removes the orchestrator's edit tools entirely.">
          <Toggle
            label="Edit files itself"
            on={rules.conduct.selfEdit}
            onChange={(selfEdit) => patchConduct({ selfEdit })}
          />
        </Row>
        <Row
          label="Run shell commands itself"
          description="Off removes its shell; context gathering goes through agents."
        >
          <Toggle
            label="Run shell commands itself"
            on={rules.conduct.selfShell}
            onChange={(selfShell) => patchConduct({ selfShell })}
          />
        </Row>
        <Row label="Verify agent reports" description="Check results before relaying them as done.">
          <Toggle
            label="Verify agent reports"
            on={rules.conduct.verifyResults}
            onChange={(verifyResults) => patchConduct({ verifyResults })}
          />
        </Row>
        <Row
          label="Escalate on weak output"
          description="Rerun with a smarter model when the result misses the bar."
        >
          <Toggle
            label="Escalate on weak output"
            on={rules.conduct.escalate}
            onChange={(escalate) => patchConduct({ escalate })}
          />
        </Row>
        <Row label="Worktree isolation" description="Writing agents get their own git worktree.">
          <Toggle
            label="Worktree isolation"
            on={rules.conduct.useWorktrees}
            onChange={(useWorktrees) => patchConduct({ useWorktrees })}
          />
        </Row>
        <Row label="Parallel agents" description="Running at once; refusals are enforced.">
          <CapSelect
            label="Parallel agents"
            value={rules.conduct.maxParallel}
            options={[0, 2, 4, 8, 16]}
            onChange={(maxParallel) => patchConduct({ maxParallel })}
          />
        </Row>
        <Row label="Total per thread" description="Lifetime cap for one orchestration.">
          <CapSelect
            label="Total per thread"
            value={rules.conduct.maxAgents}
            options={[0, 10, 20, 50]}
            onChange={(maxAgents) => patchConduct({ maxAgents })}
          />
        </Row>
      </Section>

      <Section
        title="Models"
        hint="Unapproved models are refused when threads spawn subagents."
      >
        {providersOf(catalog).map((p) => (
          <div key={p} className="pt-3 first:pt-0">
            <div className="flex items-center gap-2 pb-1 text-[11px] font-semibold tracking-[0.08em] text-content/50 uppercase">
              <HarnessIcon harness={p as HarnessId} className="size-3.5 shrink-0" />
              {catalog?.[p]?.label ?? p}
            </div>
            {(catalog?.[p]?.models ?? []).map((m) => (
              <ModelRow
                key={m.id}
                provider={p}
                model={m}
                rules={rules}
                onChange={(patch) => push(patchModelPolicy(rules, p, m.id, patch))}
              />
            ))}
          </div>
        ))}
      </Section>

      <Section
        title="Routing"
        hint="The first matching rule decides provider, model and effort."
        action={
          <SecondaryButton onClick={() => setEditing("new")}>
            <Plus className="size-3.5" strokeWidth={1.75} />
            Add rule
          </SecondaryButton>
        }
      >
        {rules.routing.map((r, ix) => (
          <RuleRow
            key={r.id}
            rule={r}
            rules={rules}
            catalog={catalog}
            first={ix === 0}
            onToggle={(enabled) => push(upsertRoutingRule(rules, { ...r, enabled }))}
            onMoveUp={() => push(moveRoutingRuleUp(rules, ix))}
            onEdit={() => setEditing(r)}
          />
        ))}
        {rules.routing.length === 0 ? (
          <p className="py-4 text-[12px] text-content/40">No rules. Subagents use each provider's default model.</p>
        ) : null}
      </Section>

      {editing ? (
        <RuleDialog
          rule={editing === "new" ? null : editing}
          rules={rules}
          catalog={catalog}
          onSave={saveRule}
          onDelete={editing === "new" ? undefined : () => deleteRule(editing.id)}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}

function Section({
  title,
  hint,
  first = false,
  action,
  children,
}: {
  title: string;
  hint: string;
  first?: boolean;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="flex items-end justify-between gap-6">
        <Heading title={title} first={first} />
        {action ? <div className="pb-1">{action}</div> : null}
      </div>
      <p className="pb-2 text-[12px] text-content/40">{hint}</p>
      {children}
    </>
  );
}

function CapSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: number;
  options: number[];
  onChange: (v: number) => void;
}) {
  const values = options.includes(value) ? options : [...options, value].sort((a, b) => a - b);
  return (
    <Select
      label={label}
      value={String(value)}
      onChange={(v) => onChange(Number(v))}
      options={values.map((o) => ({ value: String(o), label: o === 0 ? "Unlimited" : String(o) }))}
    />
  );
}

function EffortSelect({
  label,
  value,
  allowed,
  onChange,
}: {
  label: string;
  value: Reasoning;
  allowed: Reasoning[];
  onChange: (v: Reasoning) => void;
}) {
  return (
    <Select
      label={label}
      value={value}
      onChange={(v) => onChange(v as Reasoning)}
      options={allowed.map((r) => ({ value: r, label: EFFORT_LABELS[r] }))}
    />
  );
}

function ModelRow({
  provider,
  model,
  rules,
  onChange,
}: {
  provider: SpawnProviderId;
  model: ModelInfo;
  rules: OrchestrationRules;
  onChange: (patch: Partial<ModelPolicy>) => void;
}) {
  const approved = modelApproved(rules, provider, model.id);
  const range = approvedLadder(rules, provider, model.id);
  const ladder = model.reasoning;
  const min = range[0];
  const max = range[range.length - 1];
  return (
    <div
      className={`flex items-center gap-6 border-b border-content/5 py-3 last:border-b-0 ${
        approved ? "" : "opacity-40"
      }`}
    >
      <span className="min-w-0 flex-1 truncate text-[13px] text-content">{model.label}</span>
      {approved && ladder.length > 1 ? (
        <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-content/40">
          <EffortSelect
            label={`${model.label} lowest effort`}
            value={min}
            allowed={ladder.slice(0, ladder.indexOf(max) + 1)}
            onChange={(v) => onChange({ minReasoning: v === ladder[0] ? undefined : v })}
          />
          –
          <EffortSelect
            label={`${model.label} highest effort`}
            value={max}
            allowed={ladder.slice(ladder.indexOf(min))}
            onChange={(v) => onChange({ maxReasoning: v === ladder[ladder.length - 1] ? undefined : v })}
          />
        </span>
      ) : null}
      <Toggle label={`Approve ${model.label}`} on={approved} onChange={(approved) => onChange({ approved })} />
    </div>
  );
}

function RuleRow({
  rule,
  rules,
  catalog,
  first,
  onToggle,
  onMoveUp,
  onEdit,
}: {
  rule: RoutingRule;
  rules: OrchestrationRules;
  catalog: RulesCatalog | null;
  first: boolean;
  onToggle: (v: boolean) => void;
  onMoveUp: () => void;
  onEdit: () => void;
}) {
  const provider = catalog?.[rule.provider as SpawnProviderId];
  const modelId = rule.model || provider?.defaultModel || "";
  const model = provider?.models.find((m) => m.id === modelId);
  const approved = modelApproved(rules, rule.provider, modelId);
  return (
    <div
      className={`group/rule flex items-center gap-4 border-b border-content/5 py-3 last:border-b-0 ${
        rule.enabled ? "" : "opacity-40"
      }`}
    >
      <Toggle label={`Enable rule: ${rule.task}`} on={rule.enabled} onChange={onToggle} />
      <button
        type="button"
        onClick={onEdit}
        className="pressable flex min-w-0 flex-1 items-center gap-4 rounded-md text-left hover:text-content"
      >
        <span className="min-w-0 flex-1 truncate text-[13px] text-content">{rule.task}</span>
        <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-content/40">
          <HarnessIcon harness={rule.provider as HarnessId} className="size-3.5 shrink-0" />
          {model?.label ?? modelId}
          {model?.reasoning.length ? <span>· {EFFORT_LABELS[rule.reasoning]}</span> : null}
          {!approved ? <span className="text-danger">· not approved</span> : null}
        </span>
      </button>
      <button
        type="button"
        onClick={onMoveUp}
        aria-label="Move rule up"
        disabled={first}
        className="pressable grid size-6 shrink-0 place-items-center rounded-md text-content/40 opacity-0 transition-opacity hover:bg-content/10 hover:text-content focus-visible:opacity-100 group-hover/rule:opacity-100 disabled:invisible"
      >
        <ArrowUp className="size-3.5" strokeWidth={1.75} />
      </button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="text-[11px] font-semibold tracking-[0.08em] text-content/50 uppercase">{label}</span>
      {children}
    </label>
  );
}

function RuleDialog({
  rule,
  rules,
  catalog,
  onSave,
  onDelete,
  onClose,
}: {
  rule: RoutingRule | null;
  rules: OrchestrationRules;
  catalog: RulesCatalog | null;
  onSave: (r: RoutingRule) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const providers = providersOf(catalog);
  const [task, setTask] = useState(rule?.task ?? "");
  const [provider, setProvider] = useState<SpawnProviderId>(
    (rule?.provider as SpawnProviderId | undefined) ?? providers[0] ?? "claude",
  );
  const [model, setModel] = useState(rule?.model ?? "");
  const [reasoning, setReasoning] = useState<Reasoning>(rule?.reasoning ?? "medium");
  const taskRef = useRef<HTMLInputElement>(null);

  // The modal focuses its close button on mount; the task field wins on
  // the next frame.
  useEffect(() => {
    const id = requestAnimationFrame(() => taskRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  const models = useMemo(
    () => (catalog?.[provider]?.models ?? []).filter((m) => modelApproved(rules, provider, m.id)),
    [catalog, provider, rules],
  );
  const effective = model || catalog?.[provider]?.defaultModel || "";
  const ladder = useMemo(
    () => (models.some((m) => m.id === effective) ? approvedLadder(rules, provider, effective) : []),
    [models, effective, rules, provider],
  );
  // Keep effort valid for the picked model (render-time adjust).
  if (ladder.length && !ladder.includes(reasoning)) setReasoning(ladder[0]);

  const save = () => {
    if (!task.trim()) return;
    onSave({
      id: rule?.id ?? newRuleId(),
      task: task.trim(),
      provider,
      model,
      reasoning,
      enabled: rule?.enabled ?? true,
    });
  };

  return (
    <Modal onClose={onClose} title={rule ? "Edit rule" : "Add rule"} size="md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="flex flex-col gap-3 px-4 py-3">
          <Field label="When the task is…">
            <Input
              ref={taskRef}
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder="Bulk or mechanical work with a clear spec"
              className="w-full"
            />
          </Field>
          <div className="flex gap-3">
            <Field label="Provider">
              <Select
                label="Provider"
                className="w-full"
                value={provider}
                onChange={(v) => {
                  setProvider(v as SpawnProviderId);
                  setModel("");
                }}
                options={providers.map((p) => ({ value: p, label: catalog?.[p]?.label ?? p }))}
              />
            </Field>
            <Field label="Model">
              <Select
                label="Model"
                className="w-full"
                value={model}
                onChange={setModel}
                options={[
                  { value: "", label: "Provider default" },
                  ...models.map((m) => ({ value: m.id, label: m.label })),
                ]}
              />
            </Field>
            {ladder.length > 1 ? (
              <Field label="Effort">
                <Select
                  label="Effort"
                  className="w-full"
                  value={reasoning}
                  onChange={(v) => setReasoning(v as Reasoning)}
                  options={ladder.map((r) => ({ value: r, label: EFFORT_LABELS[r] }))}
                />
              </Field>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2 border-t border-content/10 px-4 py-3">
          {onDelete ? (
            <button type="button" onClick={onDelete} className={`${GHOST} text-danger hover:text-danger`}>
              Delete
            </button>
          ) : null}
          <span className="flex-1" />
          <button type="button" onClick={onClose} className={GHOST}>
            Cancel
          </button>
          <button type="submit" disabled={!task.trim()} className={PRIMARY}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
