import { useWorkspaces } from "../lib/tcserver/workspaces";
import { registry } from "../lib/connection";
import { useEnvironmentStatuses } from "../lib/connection/status";
import { loadToast } from "../components/ui/toaster";
import { Fragment, useEffect, useId, useMemo, useState } from "react";
import { ChevronRight, Plus } from "./icons";
import { HarnessIcon } from "./HarnessIcon";
import { useConfirm } from "./ConfirmDialog";
import { ChoiceSelect, type Choice } from "../components/choice-select";
import { PageEmpty, PageError, PageRow, PageRowsSkeleton, PageSection } from "../components/page";
import { ItemButton, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "../components/ui/item";
import { SettingSwitch } from "../components/setting-switch";
import { Button } from "../components/ui/button";
import { DialogFooter } from "./ConfirmDialog";
import { Field, FieldRow } from "./DialogField";
import { Modal, ModalBody, useModalClose } from "./Modal";
import { Input } from "../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { cn } from "../lib/cn";
import { EFFORT_LABELS } from "../lib/tcserver/defaults";
import {
  modelApproved,
  modelKey,
  moveRoutingRule,
  newRuleId,
  patchModelPolicy,
  removeRoutingRule,
  rulesStore,
  sliceLadder,
  staleModels,
  upsertRoutingRule,
  useRulesScope,
  type ModelPolicy,
  type OrchestrationRules,
  type RoutingRule,
  type RulesCatalog,
} from "../lib/tcserver/rules";
import { homeNote } from "../lib/settingsHome";
import type { HarnessId } from "../lib/session";
import type { ModelInfo, ProviderId, Reasoning } from "../lib/tcserver/types";

/**
 * Structured orchestration rules (server/shared/rules.ts): conduct bounds,
 * which models subagents may run, and an ordered routing table mapping kinds
 * of work to an exact provider/model/effort. Changes save immediately: these
 * are settings, not a document. Global scope is the Orchestration page; a
 * workspace override (whole-object) is the same page with that workspace
 * picked as the scope. The rules have one copy, on the box
 * (remote/rulesSync.ts): the first section says so ("Saved on box"), and
 * while that host is out of reach every control is off under "box is
 * offline"; a write it refuses anyway rolls back and says why in a toast.
 */

type Delegation = OrchestrationRules["conduct"]["delegation"];

const DELEGATION_OPTIONS: Choice<Delegation>[] = [
  { value: "strict", label: "Strict" },
  { value: "balanced", label: "Balanced" },
  { value: "free", label: "Free" },
];

export const DELEGATION_HINTS: Record<Delegation, string> = {
  strict: "Delegates everything; the orchestrator never does the work itself.",
  balanced: "Delegates substantive work; handles trivial glue itself.",
  free: "May work directly whenever that is faster.",
};

type Approval = "everyone" | "orchestrators" | "off";

const APPROVAL_OPTIONS: Choice<Approval>[] = [
  { value: "everyone", label: "Everyone" },
  { value: "orchestrators", label: "Orchestrators only" },
  { value: "off", label: "Off" },
];

/** Every provider the host's catalog lists, in its order. */
const providersOf = (catalog: RulesCatalog | null): ProviderId[] => Object.keys(catalog ?? {}) as ProviderId[];

/** A model's effort ladder as its host serves it, cut to the policy's bounds. */
const ladderOf = (rules: OrchestrationRules, provider: ProviderId, model: ModelInfo | undefined): Reasoning[] =>
  model ? sliceLadder(rules, provider, model.id, model.reasoning) : [];

const effortChoices = (levels: readonly Reasoning[]): Choice<Reasoning>[] =>
  levels.map((level) => ({ value: level, label: EFFORT_LABELS[level] }));

/** The Conduct section's rows, in their shape: Delegation, five switches, the two caps. */
const CONDUCT_SKELETON = [
  { description: true },
  { description: true, control: "switch" },
  { description: true, control: "switch" },
  { control: "switch" },
  { description: true, control: "switch" },
  { description: true, control: "switch" },
  {},
  { description: true },
] as const;

/** The Conduct section's rows while the scope loads, under its real
 *  heading; once the host has failed to answer, its error and Retry. */
export function RulesSkeleton({ workspaceId, error, onRetry }: { workspaceId: string | null; error?: string | null; onRetry?: () => void }) {
  return (
    <PageSection
      title={titlesFor(workspaceId).conduct}
      action={
        error && onRetry ? (
          <Button variant="ghost" size="sm" onClick={onRetry}>
            Retry
          </Button>
        ) : null
      }
    >
      {error ? (
        <PageError>{error}</PageError>
      ) : (
        <div data-testid="rules-skeleton">
          <PageRowsSkeleton rows={CONDUCT_SKELETON} />
        </div>
      )}
    </PageSection>
  );
}

/** The editor's sections, each of which says its own refused save. */

/** On a workspace's page the sections sit among others, so they name what they are about. */
const titlesFor = (workspaceId: string | null) =>
  workspaceId
    ? { conduct: "Orchestration", models: "Subagent models", routing: "Subagent routing" }
    : { conduct: "Conduct", models: "Subagent models", routing: "Routing" };

export function OrchestrationRulesEditor({ workspaceId }: { workspaceId: string | null }) {
  const workspace = useWorkspaces().find((w) => w.id === workspaceId);
  // Global app settings belong to this machine.
  const environmentId = workspaceId === null ? registry.primary().environmentId : workspace?.environmentId;
  if (!environmentId) return <RulesSkeleton workspaceId={workspaceId} />;
  return <RulesEditor key={environmentId} environmentId={environmentId} workspaceId={workspaceId} />;
}

/** The host's refusal as a toast says it: "Orchestration rules … live on box; it is offline". */
function refusalWords(err: unknown): string {
  const raw = (err instanceof Error ? err.message : String(err ?? "")).trim().replace(/^refused:\s*/i, "");
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "";
}

function saveFailed(err: unknown): false {
  const description = refusalWords(err);
  void loadToast().then((toast) => toast.error("Couldn't save the rules", description ? { description } : undefined));
  return false;
}

export function RulesEditor({ environmentId, workspaceId }: { environmentId: string; workspaceId: string | null }) {
  const { scope, catalog, error, retry } = useRulesScope(environmentId, workspaceId, true);
  const [editing, setEditing] = useState<RoutingRule | "new" | null>(null);
  // A host's link coming or going may move where the copy can be written:
  // the answer says so again.
  const statuses = useEnvironmentStatuses();
  const linkStates = [...statuses.values()].map((s) => s.transport).join();
  useEffect(() => {
    void rulesStore.load(environmentId, workspaceId, true).catch(() => undefined);
  }, [environmentId, workspaceId, linkStates]);

  if (!scope) return <RulesSkeleton workspaceId={workspaceId} error={error} onRetry={retry} />;
  const titles = titlesFor(workspaceId);
  const { rules, overridden } = scope;
  const stale = catalog ? staleModels(rules, catalog) : [];
  const { note, blocked } = homeNote(scope.home);

  // Settings semantics: every change persists immediately; a refused one rolls back.
  const push = (next: OrchestrationRules): Promise<unknown> =>
    rulesStore.save(environmentId, workspaceId, next).catch(saveFailed);
  const patchConduct = (patch: Partial<OrchestrationRules["conduct"]>) =>
    push({ ...rules, conduct: { ...rules.conduct, ...patch } });
  const confirm = useConfirm();
  // The global Reset wipes every routing rule and model policy too: it asks first.
  const clearScope = async () => {
    if (
      workspaceId === null &&
      !(await confirm({
        title: "Reset rules",
        body: "Every setting, model policy and routing rule goes back to the defaults.",
        action: "Reset rules",
        danger: true,
      }))
    )
      return;
    void rulesStore.clear(environmentId, workspaceId).catch(saveFailed);
  };
  const saveRule = (rule: RoutingRule, position?: number) => {
    const next = upsertRoutingRule(rules, rule);
    const at = next.routing.findIndex((r) => r.id === rule.id);
    void push(position === undefined ? next : moveRoutingRule(next, at, position));
    setEditing(null);
  };
  const deleteRule = (id: string) => {
    void push(removeRoutingRule(rules, id));
    setEditing(null);
  };

  const scopeState = workspaceId
    ? overridden
      ? "Overrides the global rules."
      : "Follows the global rules."
    : undefined;
  // One line each: whose rules these are, then where they live, 4px under it.
  const conductState =
    scopeState && note ? (
      <>
        {scopeState}
        <span className="mt-1 block">{note}</span>
      </>
    ) : (
      (scopeState ?? note)
    );
  // Only while the scope holds its own copy: the defaults have nothing to reset.
  const conductAction =
    overridden ? (
      <Button variant="ghost" size="sm" onClick={() => void clearScope()} disabled={blocked}>
        {workspaceId ? "Remove override" : "Reset"}
      </Button>
    ) : null;

  const switchRow = (title: string, description: string | undefined, key: "selfEdit" | "selfShell" | "verifyResults" | "escalate" | "useWorktrees") => (
    <PageRow title={title} description={description}>
      <SettingSwitch
        label={title}
        on={rules.conduct[key]}
        disabled={blocked}
        onChange={(on) => patchConduct({ [key]: on } as Partial<OrchestrationRules["conduct"]>)}
      />
    </PageRow>
  );

  return (
    <>
      <PageSection title={titles.conduct} description={conductState} action={conductAction}>
        <PageRow title="Delegation" description={DELEGATION_HINTS[rules.conduct.delegation]}>
          <ChoiceSelect
            label="Delegation"
            value={rules.conduct.delegation}
            options={DELEGATION_OPTIONS}
            disabled={blocked}
            onChange={(delegation) => patchConduct({ delegation })}
          />
        </PageRow>
        {switchRow("File edits", "Off removes its edit tools.", "selfEdit")}
        {switchRow("Shell commands", "Off removes its shell; agents gather context.", "selfShell")}
        {switchRow("Result checks", undefined, "verifyResults")}
        {switchRow("Escalation", "Rerun with a smarter model when a result misses.", "escalate")}
        {switchRow("Worktree isolation", "Writing agents get their own git worktree.", "useWorktrees")}
        <PageRow title="Parallel agents">
          <CapSelect
            label="Parallel agents"
            value={rules.conduct.maxParallel}
            options={[0, 2, 4, 8, 16, 32, 64, 128]}
            disabled={blocked}
            onChange={(maxParallel) => patchConduct({ maxParallel })}
          />
        </PageRow>
        <PageRow title="Total per thread" description="Over one orchestration's life.">
          <CapSelect
            label="Total per thread"
            value={rules.conduct.maxAgents}
            options={[0, 10, 20, 50]}
            disabled={blocked}
            onChange={(maxAgents) => patchConduct({ maxAgents })}
          />
        </PageRow>
      </PageSection>

      <PageSection title={titles.models} description="A thread may run any model.">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead>Spawned by</TableHead>
              <TableHead className="text-end">Effort</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {providersOf(catalog).map((p) => {
              const info = catalog?.[p];
              const label = info?.label ?? p;
              const models = info?.models ?? [];
              return (
                <Fragment key={p}>
                  <TableRow data-slot="table-group-row" className="border-b-0">
                    <TableCell colSpan={3} className="h-8 pt-2">
                      <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                        <HarnessIcon harness={p as HarnessId} className="size-3.5 shrink-0" />
                        {label}
                      </span>
                    </TableCell>
                  </TableRow>
                  {models.length === 0 ? (
                    <TableRow data-slot="table-empty-row">
                      <TableCell colSpan={3} className="text-xs text-muted-foreground">
                        No models until {label} is installed and signed in
                      </TableCell>
                    </TableRow>
                  ) : null}
                  {models.map((m) => (
                    <ModelRow
                      key={m.id}
                      provider={p}
                      id={m.id}
                      model={m}
                      rules={rules}
                      disabled={blocked}
                      onChange={(patch) => push(patchModelPolicy(rules, p, m.id, patch))}
                    />
                  ))}
                  {stale
                    .filter((m) => m.provider === p)
                    .map((m) => (
                      <ModelRow
                        key={`stale:${m.id}`}
                        provider={p}
                        id={m.id}
                        rules={rules}
                        disabled={blocked}
                        onChange={(patch) => push(patchModelPolicy(rules, p, m.id, patch))}
                      />
                    ))}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </PageSection>

      <PageSection
        title={titles.routing}
        description="The first rule that matches decides provider, model and effort."
        action={
          <Button variant="ghost" size="sm" onClick={() => setEditing("new")} disabled={blocked}>
            <Plus />
            Add rule
          </Button>
        }
      >
        {rules.routing.map((r) => (
          <RuleRow key={r.id} rule={r} rules={rules} catalog={catalog} disabled={blocked} onEdit={() => setEditing(r)} />
        ))}
        {rules.routing.length === 0 ? (
          <PageEmpty>No rules</PageEmpty>
        ) : null}
      </PageSection>

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

function CapSelect({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  options: number[];
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  const values = options.includes(value) ? options : [...options, value].sort((a, b) => a - b);
  return (
    <ChoiceSelect
      label={label}
      value={String(value)}
      onChange={(v) => onChange(Number(v))}
      disabled={disabled}
      options={values.map((o) => ({ value: String(o), label: o === 0 ? "Unlimited" : String(o) }))}
    />
  );
}

/** One model's policy. With no `model` the rules name a model this host's
 *  catalog lacks: its row stays, muted and without effort, so the saved
 *  policy is seen and kept. */
function ModelRow({
  provider,
  id,
  model,
  rules,
  disabled,
  onChange,
}: {
  provider: ProviderId;
  id: string;
  model?: ModelInfo;
  rules: OrchestrationRules;
  disabled?: boolean;
  onChange: (patch: Partial<ModelPolicy>) => void;
}) {
  // Everyone / Orchestrators only / Off (CLAUDE.md "Master threads"): an
  // orchestrators-only model keeps its effort bounds, it is approved for
  // someone. A model the saved rules do not list reads Off.
  const policy = rules.models[modelKey(provider, id)]?.approved ?? false;
  const approved = policy !== false;
  const name = model?.label ?? id;
  const range = ladderOf(rules, provider, model);
  const ladder = model?.reasoning ?? [];
  const min = range[0];
  const max = range[range.length - 1];
  return (
    <TableRow data-stale={model ? undefined : ""}>
      <TableCell className={cn("w-full truncate", approved && model ? "text-foreground" : "text-muted-foreground")}>
        {name}
        {model ? null : <span className="ms-1 text-xs">not on this host</span>}
      </TableCell>
      <TableCell>
        <ChoiceSelect
          size="sm"
          label={`Who may spawn ${name}`}
          value={policy === true ? "everyone" : policy === false ? "off" : "orchestrators"}
          onChange={(v) => onChange({ approved: v === "everyone" ? true : v === "off" ? false : "orchestrators" })}
          options={APPROVAL_OPTIONS}
          disabled={disabled}
          className="w-44"
        />
      </TableCell>
      <TableCell className="text-end">
        {approved && ladder.length > 1 ? (
          <span className="inline-flex items-center gap-2">
            <ChoiceSelect
              size="sm"
              label={`${name} lowest effort`}
              value={min}
              disabled={disabled}
              options={effortChoices(ladder.slice(0, ladder.indexOf(max) + 1))}
              onChange={(v) => onChange({ minReasoning: v === ladder[0] ? undefined : v })}
            />
            <span className="text-muted-foreground">–</span>
            <ChoiceSelect
              size="sm"
              label={`${name} highest effort`}
              value={max}
              disabled={disabled}
              options={effortChoices(ladder.slice(ladder.indexOf(min)))}
              onChange={(v) => onChange({ maxReasoning: v === ladder[ladder.length - 1] ? undefined : v })}
            />
          </span>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

/** One rule: the whole row opens its dialog, which holds every change. */
function RuleRow({
  rule,
  rules,
  catalog,
  disabled,
  onEdit,
}: {
  rule: RoutingRule;
  rules: OrchestrationRules;
  catalog: RulesCatalog | null;
  disabled?: boolean;
  onEdit: () => void;
}) {
  const provider = catalog?.[rule.provider];
  const modelId = rule.model || provider?.defaultModel || "";
  const model = provider?.models.find((m) => m.id === modelId);
  const approved = modelApproved(rules, rule.provider, modelId);
  const orchestratorsOnly = !approved && modelApproved(rules, rule.provider, modelId, "orchestrator");
  const factsId = useId();
  // The row keeps the page's hairline; the button inside it carries the hover fill.
  return (
    <div data-slot="page-row" className="py-1 [[data-slot=page-row]+&]:border-t [[data-slot=page-row]+&]:border-border">
      <ItemButton
        aria-label={`Edit rule: ${rule.task}`}
        aria-describedby={factsId}
        onClick={onEdit}
        disabled={disabled}
        className="-mx-2 w-[calc(100%+1rem)] rounded-md px-2 py-2 hover:bg-foreground/5"
      >
        <ItemMedia>
          <HarnessIcon harness={rule.provider as HarnessId} className="size-4 shrink-0" />
        </ItemMedia>
        <ItemContent className="min-w-0">
          <ItemTitle className={rule.enabled ? undefined : "text-muted-foreground"}>{rule.task}</ItemTitle>
          <ItemDescription id={factsId} className="line-clamp-none">
            <span className="flex flex-wrap items-center gap-2">
              {rule.enabled ? null : <span>Off</span>}
              <span>{model?.label ?? modelId}</span>
              {model?.reasoning.length ? <span>{EFFORT_LABELS[rule.reasoning]}</span> : null}
              {orchestratorsOnly ? <span>Orchestrators only</span> : !approved ? <span className="text-warning">Not approved</span> : null}
            </span>
          </ItemDescription>
        </ItemContent>
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
      </ItemButton>
    </div>
  );
}

type RuleDialogProps = {
  rule: RoutingRule | null;
  rules: OrchestrationRules;
  catalog: RulesCatalog | null;
  /** The rule, and for an existing one its 0-based place in the list. */
  onSave: (r: RoutingRule, position?: number) => void;
  onDelete?: () => void;
  onClose: () => void;
};

export function RuleDialog(props: RuleDialogProps) {
  return (
    <Modal onClose={props.onClose} title={props.rule ? "Edit rule" : "Add rule"} size="sm">
      <RuleForm {...props} />
    </Modal>
  );
}

/** Save and Delete play the dialog's exit, then change the rules. */
function RuleForm({ rule, rules, catalog, onSave, onDelete, onClose }: RuleDialogProps) {
  const close = useModalClose();
  const thenClose = (fn: () => void) => (close ? close(fn) : fn());
  const providers = providersOf(catalog).filter((p) => (catalog?.[p]?.models.length ?? 0) > 0);
  const index = rule ? rules.routing.findIndex((r) => r.id === rule.id) : -1;
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [position, setPosition] = useState(Math.max(index, 0));
  const [task, setTask] = useState(rule?.task ?? "");
  const [provider, setProvider] = useState<ProviderId>(rule?.provider ?? providers[0] ?? "claude");
  const [model, setModel] = useState(rule?.model ?? "");
  const [reasoning, setReasoning] = useState<Reasoning>(rule?.reasoning ?? "medium");

  const models = useMemo(
    () => (catalog?.[provider]?.models ?? []).filter((m) => modelApproved(rules, provider, m.id)),
    [catalog, provider, rules],
  );
  const effective = model || catalog?.[provider]?.defaultModel || "";
  const ladder = useMemo(
    () => ladderOf(rules, provider, models.find((m) => m.id === effective)),
    [models, effective, rules, provider],
  );
  // Keep effort valid for the picked model (render-time adjust).
  if (ladder.length && !ladder.includes(reasoning)) setReasoning(ladder[0]);

  const save = () => {
    if (!task.trim()) return;
    const next = { id: rule?.id ?? newRuleId(), task: task.trim(), provider, model, reasoning, enabled };
    thenClose(() => onSave(next, index >= 0 ? position : undefined));
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <ModalBody>
        <Field label="When the task is">
          <Input autoFocus value={task} onChange={(e) => setTask(e.target.value)} placeholder="Bulk or mechanical work with a clear spec" />
        </Field>
        <div className="flex flex-col">
          <FieldRow label="Provider">
            <ChoiceSelect
              label="Provider"
              size="sm"
              value={provider}
              onChange={(v) => {
                setProvider(v);
                setModel("");
              }}
              options={providers.map((p) => ({ value: p, label: catalog?.[p]?.label ?? p }))}
            />
          </FieldRow>
          <FieldRow label="Model">
            <ChoiceSelect
              label="Model"
              size="sm"
              value={model}
              onChange={setModel}
              options={[{ value: "", label: "Provider default" }, ...models.map((m) => ({ value: m.id, label: m.label }))]}
            />
          </FieldRow>
          {ladder.length > 1 ? (
            <FieldRow label="Effort">
              <ChoiceSelect label="Effort" size="sm" value={reasoning} onChange={setReasoning} options={effortChoices(ladder)} />
            </FieldRow>
          ) : null}
          {index >= 0 ? (
            <>
              <FieldRow label="Position">
                <ChoiceSelect
                  label="Position"
                  size="sm"
                  value={String(position)}
                  onChange={(v) => setPosition(Number(v))}
                  options={rules.routing.map((_, i) => ({ value: String(i), label: String(i + 1) }))}
                />
              </FieldRow>
              <FieldRow label="Enabled">
                <SettingSwitch label="Enabled" on={enabled} onChange={setEnabled} />
              </FieldRow>
            </>
          ) : null}
        </div>
      </ModalBody>
      <DialogFooter
        start={
          onDelete ? (
            <Button type="button" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => thenClose(onDelete)}>
              Delete
            </Button>
          ) : null
        }
        onCancel={onClose}
        confirmLabel="Save"
        disabled={!task.trim()}
      />
    </form>
  );
}
