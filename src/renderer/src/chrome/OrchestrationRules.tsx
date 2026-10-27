import { useWorkspaces } from "../lib/tcserver/workspaces";
import { registry } from "../lib/connection";
import { Fragment, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal, Plus } from "./icons";
import { HarnessIcon } from "./HarnessIcon";
import { ChoiceSelect, type Choice } from "../components/choice-select";
import { PageRow, PageSection } from "../components/page";
import { SettingSwitch } from "../components/setting-switch";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/cn";
import { EFFORT_LABELS } from "../lib/tcserver/defaults";
import {
  approvedLadder,
  modelApproved,
  modelKey,
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

/**
 * Structured orchestration rules (server/shared/rules.ts): conduct bounds,
 * which models subagents may run, and an ordered routing table mapping kinds
 * of work to an exact provider/model/effort. Changes save immediately: these
 * are settings, not a document. Global scope is the Orchestration page; a
 * workspace override (whole-object) is the same page with that workspace
 * picked as the scope.
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

const providersOf = (catalog: RulesCatalog | null): SpawnProviderId[] =>
  SPAWN_PROVIDERS.filter((p): p is SpawnProviderId => !!catalog?.[p as SpawnProviderId]);

const effortChoices = (levels: readonly Reasoning[]): Choice<Reasoning>[] =>
  levels.map((level) => ({ value: level, label: EFFORT_LABELS[level] }));

/** The Conduct section's rows while the scope loads, under its real heading. */
export function RulesSkeleton({ workspaceId }: { workspaceId: string | null }) {
  return (
    <PageSection title={titlesFor(workspaceId).conduct}>
      <div data-testid="rules-skeleton" aria-hidden className="flex flex-col">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-3 py-3">
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-3 w-56" />
            </div>
            <Skeleton className="h-5 w-8 rounded-full" />
          </div>
        ))}
      </div>
    </PageSection>
  );
}

/** On a workspace's page the sections sit among others, so they name what they are about. */
const titlesFor = (workspaceId: string | null) =>
  workspaceId
    ? { conduct: "Orchestration", models: "Subagent models", routing: "Subagent routing" }
    : { conduct: "Conduct", models: "Models", routing: "Routing" };

export function OrchestrationRulesEditor({ workspaceId }: { workspaceId: string | null }) {
  const workspace = useWorkspaces().find((w) => w.id === workspaceId);
  // Global app settings belong to this machine.
  const environmentId = workspaceId === null ? registry.primary().environmentId : workspace?.environmentId;
  if (!environmentId) return <RulesSkeleton workspaceId={workspaceId} />;
  return <RulesEditor key={environmentId} environmentId={environmentId} workspaceId={workspaceId} />;
}

function RulesEditor({ environmentId, workspaceId }: { environmentId: string; workspaceId: string | null }) {
  const { scope, catalog } = useRulesScope(environmentId, workspaceId);
  const [editing, setEditing] = useState<RoutingRule | "new" | null>(null);

  if (!scope) return <RulesSkeleton workspaceId={workspaceId} />;
  const titles = titlesFor(workspaceId);
  const { rules, overridden } = scope;

  // Settings semantics: every change persists immediately.
  const push = (next: OrchestrationRules) => void rulesStore.save(environmentId, workspaceId, next);
  const patchConduct = (patch: Partial<OrchestrationRules["conduct"]>) =>
    push({ ...rules, conduct: { ...rules.conduct, ...patch } });
  const clearScope = () => void rulesStore.clear(environmentId, workspaceId);
  const saveRule = (rule: RoutingRule) => {
    push(upsertRoutingRule(rules, rule));
    setEditing(null);
  };
  const deleteRule = (id: string) => {
    push(removeRoutingRule(rules, id));
    setEditing(null);
  };

  const conductState = workspaceId
    ? overridden
      ? "This workspace overrides the global rules."
      : "Following the global rules. A change makes an override."
    : undefined;
  const conductAction =
    !workspaceId || overridden ? (
      <Button variant="ghost" size="sm" onClick={clearScope}>
        {workspaceId ? "Remove override" : "Reset"}
      </Button>
    ) : null;

  const switchRow = (title: string, description: string, key: "selfEdit" | "selfShell" | "verifyResults" | "escalate" | "useWorktrees") => (
    <PageRow title={title} description={description}>
      <SettingSwitch label={title} on={rules.conduct[key]} onChange={(on) => patchConduct({ [key]: on } as Partial<OrchestrationRules["conduct"]>)} />
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
            onChange={(delegation) => patchConduct({ delegation })}
          />
        </PageRow>
        {switchRow("File edits", "Off removes its edit tools.", "selfEdit")}
        {switchRow("Shell commands", "Off removes its shell; agents gather context.", "selfShell")}
        {switchRow("Report checks", "Check results before relaying them.", "verifyResults")}
        {switchRow("Escalation", "Rerun with a smarter model when a result misses.", "escalate")}
        {switchRow("Worktree isolation", "Writing agents get their own git worktree.", "useWorktrees")}
        <PageRow title="Parallel agents" description="Running at once.">
          <CapSelect
            label="Parallel agents"
            value={rules.conduct.maxParallel}
            options={[0, 2, 4, 8, 16, 32, 64, 128]}
            onChange={(maxParallel) => patchConduct({ maxParallel })}
          />
        </PageRow>
        <PageRow title="Total per thread" description="Over one orchestration's life.">
          <CapSelect
            label="Total per thread"
            value={rules.conduct.maxAgents}
            options={[0, 10, 20, 50]}
            onChange={(maxAgents) => patchConduct({ maxAgents })}
          />
        </PageRow>
      </PageSection>

      <PageSection title={titles.models} description="Applies to subagents. A thread may run any model.">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead>Spawned by</TableHead>
              <TableHead className="text-end">Effort</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {providersOf(catalog).map((p) => (
              <Fragment key={p}>
                <TableRow data-slot="table-group-row" className="border-b-0">
                  <TableCell colSpan={3} className="h-8 pt-2">
                    <span className="flex items-center gap-2 text-[12px] font-medium text-muted-foreground">
                      <HarnessIcon harness={p as HarnessId} className="size-3.5 shrink-0" />
                      {catalog?.[p]?.label ?? p}
                    </span>
                  </TableCell>
                </TableRow>
                {(catalog?.[p]?.models ?? []).map((m) => (
                  <ModelRow
                    key={m.id}
                    provider={p}
                    model={m}
                    rules={rules}
                    onChange={(patch) => push(patchModelPolicy(rules, p, m.id, patch))}
                  />
                ))}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </PageSection>

      <PageSection
        title={titles.routing}
        description="The first rule that matches decides provider, model and effort."
        action={
          <Button variant="ghost" size="sm" onClick={() => setEditing("new")}>
            <Plus />
            Add rule
          </Button>
        }
      >
        {rules.routing.map((r, ix) => (
          <RuleRow
            key={r.id}
            rule={r}
            rules={rules}
            catalog={catalog}
            first={ix === 0}
            last={ix === rules.routing.length - 1}
            onToggle={(enabled) => push(upsertRoutingRule(rules, { ...r, enabled }))}
            onMoveUp={() => push(moveRoutingRuleUp(rules, ix))}
            onMoveDown={() => push(moveRoutingRuleUp(rules, ix + 1))}
            onEdit={() => setEditing(r)}
          />
        ))}
        {rules.routing.length === 0 ? (
          <p className="py-3 text-[12px] text-muted-foreground">No rules. Subagents use each provider's default model.</p>
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
  onChange,
}: {
  label: string;
  value: number;
  options: number[];
  onChange: (v: number) => void;
}) {
  const values = options.includes(value) ? options : [...options, value].sort((a, b) => a - b);
  return (
    <ChoiceSelect
      label={label}
      value={String(value)}
      onChange={(v) => onChange(Number(v))}
      options={values.map((o) => ({ value: String(o), label: o === 0 ? "Unlimited" : String(o) }))}
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
  // Everyone / Orchestrators only / Off (CLAUDE.md "Master threads"): an
  // orchestrators-only model keeps its effort bounds, it is approved for
  // someone. A model the saved rules do not list reads Off.
  const policy = rules.models[modelKey(provider, model.id)]?.approved ?? false;
  const approved = policy !== false;
  const range = approvedLadder(rules, provider, model.id);
  const ladder = model.reasoning;
  const min = range[0];
  const max = range[range.length - 1];
  return (
    <TableRow>
      <TableCell className={cn("w-full truncate", approved ? "text-foreground" : "text-muted-foreground")}>
        {model.label}
      </TableCell>
      <TableCell>
        <ChoiceSelect
          size="sm"
          label={`Who may spawn ${model.label}`}
          value={policy === true ? "everyone" : policy === false ? "off" : "orchestrators"}
          onChange={(v) => onChange({ approved: v === "everyone" ? true : v === "off" ? false : "orchestrators" })}
          options={APPROVAL_OPTIONS}
          className="w-44"
        />
      </TableCell>
      <TableCell className="text-end">
        {approved && ladder.length > 1 ? (
          <span className="inline-flex items-center gap-2">
            <ChoiceSelect
              size="sm"
              label={`${model.label} lowest effort`}
              value={min}
              options={effortChoices(ladder.slice(0, ladder.indexOf(max) + 1))}
              onChange={(v) => onChange({ minReasoning: v === ladder[0] ? undefined : v })}
            />
            <span className="text-muted-foreground">–</span>
            <ChoiceSelect
              size="sm"
              label={`${model.label} highest effort`}
              value={max}
              options={effortChoices(ladder.slice(ladder.indexOf(min)))}
              onChange={(v) => onChange({ maxReasoning: v === ladder[ladder.length - 1] ? undefined : v })}
            />
          </span>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

function RuleRow({
  rule,
  rules,
  catalog,
  first,
  last,
  onToggle,
  onMoveUp,
  onMoveDown,
  onEdit,
}: {
  rule: RoutingRule;
  rules: OrchestrationRules;
  catalog: RulesCatalog | null;
  first: boolean;
  last: boolean;
  onToggle: (v: boolean) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onEdit: () => void;
}) {
  const provider = catalog?.[rule.provider as SpawnProviderId];
  const modelId = rule.model || provider?.defaultModel || "";
  const model = provider?.models.find((m) => m.id === modelId);
  const approved = modelApproved(rules, rule.provider, modelId);
  const orchestratorsOnly = !approved && modelApproved(rules, rule.provider, modelId, "orchestrator");
  return (
    <PageRow
      media={<HarnessIcon harness={rule.provider as HarnessId} className="size-4 shrink-0" />}
      title={<span className={rule.enabled ? undefined : "text-muted-foreground"}>{rule.task}</span>}
      description={
        <span className="flex flex-wrap items-center gap-2">
          <span>{model?.label ?? modelId}</span>
          {model?.reasoning.length ? <span>{EFFORT_LABELS[rule.reasoning]}</span> : null}
          {orchestratorsOnly ? <span>Orchestrators only</span> : !approved ? <span className="text-warning">Not approved</span> : null}
        </span>
      }
    >
      <SettingSwitch label={`Enable rule: ${rule.task}`} on={rule.enabled} onChange={onToggle} />
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={<DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Rule actions" />} />}
          >
            <MoreHorizontal />
          </TooltipTrigger>
          <TooltipContent>Rule actions</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onEdit}>Edit…</DropdownMenuItem>
          <DropdownMenuItem disabled={first} onClick={onMoveUp}>
            Move up
          </DropdownMenuItem>
          <DropdownMenuItem disabled={last} onClick={onMoveDown}>
            Move down
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </PageRow>
  );
}

/** A dialog field: a 12px medium label over its control. */
function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[12px] font-medium text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

export function RuleDialog({
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
  const taskId = useId();

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
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent initialFocus={taskRef}>
        <DialogHeader>
          <DialogTitle>{rule ? "Edit rule" : "Add rule"}</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <Field label="When the task is" htmlFor={taskId}>
            <Input
              id={taskId}
              ref={taskRef}
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder="Bulk or mechanical work with a clear spec"
            />
          </Field>
          <div className="flex gap-3">
            <Field label="Provider">
              <ChoiceSelect
                label="Provider"
                className="w-full"
                value={provider}
                onChange={(v) => {
                  setProvider(v);
                  setModel("");
                }}
                options={providers.map((p) => ({ value: p, label: catalog?.[p]?.label ?? p }))}
              />
            </Field>
            <Field label="Model">
              <ChoiceSelect
                label="Model"
                className="w-full"
                value={model}
                onChange={setModel}
                options={[{ value: "", label: "Provider default" }, ...models.map((m) => ({ value: m.id, label: m.label }))]}
              />
            </Field>
            {ladder.length > 1 ? (
              <Field label="Effort">
                <ChoiceSelect label="Effort" className="w-full" value={reasoning} onChange={setReasoning} options={effortChoices(ladder)} />
              </Field>
            ) : null}
          </div>
          <DialogFooter className="items-center">
            {onDelete ? (
              <Button type="button" variant="destructive" onClick={onDelete}>
                Delete
              </Button>
            ) : null}
            <span className="flex-1" />
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!task.trim()}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
