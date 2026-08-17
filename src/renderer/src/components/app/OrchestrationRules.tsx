import { useEffect, useMemo, useState } from 'react'
import { ArrowUp, Plus } from 'lucide-react'
import {
  approvedLadder,
  modelApproved,
  modelKey,
  type ModelPolicy,
  type OrchestrationRules,
  type RoutingRule
} from '@shared/rules'
import type { ModelInfo, ProviderId, Reasoning } from '@shared/catalog'
import { client } from '../../lib/client'
import { useApp } from '../../state/store'
import { cn } from '../../lib/utils'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Switch } from '../ui/switch'
import { Spinner } from '../ui/spinner'
import { ProviderMark } from './bits'
import { SettingsGroup, SettingsPanel, SettingsRow } from './SettingsPanel'

/**
 * Structured orchestration rules (shared/rules.ts): conduct bounds with
 * real switches, and an ordered routing table mapping kinds of work to an
 * exact provider/model/effort. Changes save immediately — these are
 * settings, not a document. Global scope lives in Settings; a workspace
 * override (whole-object) is edited from its sidebar menu.
 */

const EFFORT_LABELS: Record<Reasoning, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra'
}

const DELEGATION_OPTIONS: { value: OrchestrationRules['conduct']['delegation']; label: string }[] =
  [
    { value: 'strict', label: 'Strict' },
    { value: 'balanced', label: 'Balanced' },
    { value: 'free', label: 'Free' }
  ]

const DELEGATION_HINTS: Record<OrchestrationRules['conduct']['delegation'], string> = {
  strict: 'Delegates everything; the orchestrator never does the work itself.',
  balanced: 'Delegates substantive work; handles trivial glue itself.',
  free: 'May work directly whenever that is faster.'
}

interface RulesPayload {
  rules: OrchestrationRules
  overridden: boolean
}

export function OrchestrationRulesEditor({
  workspaceId
}: {
  workspaceId: string | null
}): React.JSX.Element {
  const catalog = useApp((s) => s.catalog)
  const [rules, setRules] = useState<OrchestrationRules | null>(null)
  const [overridden, setOverridden] = useState(false)
  const [editing, setEditing] = useState<RoutingRule | 'new' | null>(null)

  useEffect(() => {
    void client.request<RulesPayload>('rules.get', { workspaceId }).then((p) => {
      setRules(p.rules)
      setOverridden(p.overridden)
    })
  }, [workspaceId])

  if (!rules) {
    return (
      <div className="flex h-24 items-center justify-center">
        <Spinner className="size-4 text-muted-foreground/60" />
      </div>
    )
  }

  // Settings semantics: every change persists immediately.
  const push = (next: OrchestrationRules): void => {
    setRules(next)
    setOverridden(true)
    void client.request('rules.set', { workspaceId, rules: next })
  }
  const patchConduct = (patch: Partial<OrchestrationRules['conduct']>): void =>
    push({ ...rules, conduct: { ...rules.conduct, ...patch } })
  // A policy back at its default (approved, unbounded) leaves the store.
  const patchModel = (p: ProviderId, modelId: string, patch: Partial<ModelPolicy>): void => {
    const key = modelKey(p, modelId)
    const prev: ModelPolicy = rules.models[key] ?? { approved: true }
    const next: ModelPolicy = { ...prev, ...patch }
    const models = { ...rules.models }
    if (next.approved && !next.minReasoning && !next.maxReasoning) delete models[key]
    else models[key] = next
    push({ ...rules, models })
  }

  const clearScope = (): void => {
    void client.request('rules.set', { workspaceId, rules: null }).then(() =>
      client.request<RulesPayload>('rules.get', { workspaceId }).then((p) => {
        setRules(p.rules)
        setOverridden(p.overridden)
      })
    )
  }

  const saveRule = (rule: RoutingRule): void => {
    const exists = rules.routing.some((r) => r.id === rule.id)
    push({
      ...rules,
      routing: exists
        ? rules.routing.map((r) => (r.id === rule.id ? rule : r))
        : [...rules.routing, rule]
    })
    setEditing(null)
  }
  const deleteRule = (id: string): void => {
    push({ ...rules, routing: rules.routing.filter((r) => r.id !== id) })
    setEditing(null)
  }
  const moveUp = (ix: number): void => {
    if (ix === 0) return
    const routing = [...rules.routing]
    ;[routing[ix - 1], routing[ix]] = [routing[ix], routing[ix - 1]]
    push({ ...rules, routing })
  }

  return (
    <div className="flex flex-col gap-7">
      <SettingsGroup
        title="Conduct"
        hint={
          workspaceId
            ? overridden
              ? 'This workspace overrides the global rules.'
              : 'Using the global rules; any change creates a workspace override.'
            : 'The defaults for every orchestration; each thread can override them when you start it. Denied abilities are enforced, not suggested.'
        }
        action={
          <button
            onClick={clearScope}
            className={cn(
              'shrink-0 text-[11px] text-muted-foreground transition-colors hover:text-foreground',
              !overridden && !!workspaceId && 'invisible'
            )}
          >
            {workspaceId ? 'Remove override' : 'Reset'}
          </button>
        }
      >
        <SettingsPanel>
          <SettingsRow label="Delegation" description={DELEGATION_HINTS[rules.conduct.delegation]}>
            <div className="inline-flex items-center gap-0.5 rounded-lg bg-secondary/60 p-0.5">
              {DELEGATION_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  onClick={() => patchConduct({ delegation: o.value })}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-xs transition-colors',
                    rules.conduct.delegation === o.value
                      ? 'bg-background text-foreground shadow-[0_1px_3px_rgb(0_0_0/0.12)] dark:bg-accent'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </SettingsRow>
          <SettingsRow
            label="Edit files itself"
            description="Off removes the orchestrator's edit tools entirely."
          >
            <Switch
              checked={rules.conduct.selfEdit}
              onChange={(v) => patchConduct({ selfEdit: v })}
              aria-label="Edit files itself"
            />
          </SettingsRow>
          <SettingsRow
            label="Run shell commands itself"
            description="Off removes its shell; context gathering goes through agents."
          >
            <Switch
              checked={rules.conduct.selfShell}
              onChange={(v) => patchConduct({ selfShell: v })}
              aria-label="Run shell commands itself"
            />
          </SettingsRow>
          <SettingsRow
            label="Verify agent reports"
            description="Check results before relaying them as done."
          >
            <Switch
              checked={rules.conduct.verifyResults}
              onChange={(v) => patchConduct({ verifyResults: v })}
              aria-label="Verify agent reports"
            />
          </SettingsRow>
          <SettingsRow
            label="Escalate on weak output"
            description="Rerun with a smarter model when the result misses the bar."
          >
            <Switch
              checked={rules.conduct.escalate}
              onChange={(v) => patchConduct({ escalate: v })}
              aria-label="Escalate on weak output"
            />
          </SettingsRow>
          <SettingsRow
            label="Worktree isolation"
            description="Writing agents get their own git worktree."
          >
            <Switch
              checked={rules.conduct.useWorktrees}
              onChange={(v) => patchConduct({ useWorktrees: v })}
              aria-label="Worktree isolation"
            />
          </SettingsRow>
          <SettingsRow
            label="Parallel agents"
            description="Running at once; refusals are enforced."
          >
            <CapSelect
              value={rules.conduct.maxParallel}
              options={[0, 2, 4, 8, 16]}
              onChange={(v) => patchConduct({ maxParallel: v })}
            />
          </SettingsRow>
          <SettingsRow label="Total per thread" description="Lifetime cap for one orchestration.">
            <CapSelect
              value={rules.conduct.maxAgents}
              options={[0, 10, 20, 50]}
              onChange={(v) => patchConduct({ maxAgents: v })}
            />
          </SettingsRow>
        </SettingsPanel>
      </SettingsGroup>

      <SettingsGroup
        title="Models"
        hint="Unapproved models are refused when threads spawn subagents; efforts clamp into each range."
      >
        <div className="flex flex-col gap-3">
          {(Object.keys(catalog ?? {}) as ProviderId[]).map((p) => (
            <SettingsPanel key={p}>
              <div className="flex items-center gap-2 px-4 py-2 text-[11px] text-muted-foreground">
                <ProviderMark provider={p} size={11} />
                {catalog?.[p].label ?? p}
              </div>
              {(catalog?.[p].models ?? []).map((m) => (
                <ModelRow
                  key={m.id}
                  provider={p}
                  model={m}
                  rules={rules}
                  onChange={(patch) => patchModel(p, m.id, patch)}
                />
              ))}
            </SettingsPanel>
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup
        title="Routing"
        hint="The first matching rule decides provider, model, and effort. Click a rule to edit it."
      >
        <SettingsPanel>
          {rules.routing.map((r, ix) => (
            <RuleRow
              key={r.id}
              rule={r}
              rules={rules}
              first={ix === 0}
              onToggle={(v) =>
                push({
                  ...rules,
                  routing: rules.routing.map((x) => (x.id === r.id ? { ...x, enabled: v } : x))
                })
              }
              onMoveUp={() => moveUp(ix)}
              onEdit={() => setEditing(r)}
            />
          ))}
          <button
            onClick={() => setEditing('new')}
            className="flex h-10 w-full items-center gap-1.5 px-4 text-[13px] text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
          >
            <Plus className="size-3.5" /> Add rule
          </button>
        </SettingsPanel>
      </SettingsGroup>

      {editing && (
        <RuleDialog
          rule={editing === 'new' ? null : editing}
          rules={rules}
          onSave={saveRule}
          onDelete={editing === 'new' ? undefined : () => deleteRule(editing.id)}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

function CapSelect({
  value,
  options,
  onChange
}: {
  value: number
  options: number[]
  onChange: (v: number) => void
}): React.JSX.Element {
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger size="sm" className="w-28">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o} value={String(o)}>
            {o === 0 ? 'Unlimited' : String(o)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function ModelRow({
  provider,
  model,
  rules,
  onChange
}: {
  provider: ProviderId
  model: ModelInfo
  rules: OrchestrationRules
  onChange: (patch: Partial<ModelPolicy>) => void
}): React.JSX.Element {
  const approved = modelApproved(rules, provider, model.id)
  const range = approvedLadder(rules, provider, model.id)
  const ladder = model.reasoning
  const min = range[0]
  const max = range[range.length - 1]
  const effortSelect = (
    value: Reasoning,
    allowed: Reasoning[],
    save: (v: Reasoning) => void
  ): React.JSX.Element => (
    <Select value={value} onValueChange={(v) => save(v as Reasoning)}>
      <SelectTrigger size="sm" className="w-24">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {allowed.map((r) => (
          <SelectItem key={r} value={r}>
            {EFFORT_LABELS[r]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
  return (
    <div className={cn('flex items-center gap-4 px-4 py-2.5', !approved && 'opacity-50')}>
      <span className="min-w-0 flex-1 truncate text-[13px]">{model.label}</span>
      {approved && ladder.length > 1 && (
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          {effortSelect(min, ladder.slice(0, ladder.indexOf(max) + 1), (v) =>
            onChange({ minReasoning: v === ladder[0] ? undefined : v })
          )}
          –
          {effortSelect(max, ladder.slice(ladder.indexOf(min)), (v) =>
            onChange({ maxReasoning: v === ladder[ladder.length - 1] ? undefined : v })
          )}
        </span>
      )}
      <Switch
        checked={approved}
        onChange={(v) => onChange({ approved: v })}
        aria-label={`Approve ${model.label}`}
      />
    </div>
  )
}

function RuleRow({
  rule,
  rules,
  first,
  onToggle,
  onMoveUp,
  onEdit
}: {
  rule: RoutingRule
  rules: OrchestrationRules
  first: boolean
  onToggle: (v: boolean) => void
  onMoveUp: () => void
  onEdit: () => void
}): React.JSX.Element {
  const catalog = useApp((s) => s.catalog)
  const modelId = rule.model || catalog?.[rule.provider]?.defaultModel || ''
  const model = catalog?.[rule.provider]?.models.find((m) => m.id === modelId)
  const approved = modelApproved(rules, rule.provider, modelId)
  return (
    <div
      className={cn(
        'group/rule flex items-center gap-3 px-4 py-2.5 transition-opacity',
        !rule.enabled && 'opacity-50'
      )}
    >
      <Switch checked={rule.enabled} onChange={onToggle} aria-label={`Enable rule: ${rule.task}`} />
      <button onClick={onEdit} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <span className="min-w-0 flex-1 truncate text-[13px]">{rule.task}</span>
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <ProviderMark provider={rule.provider} size={11} />
          {model?.label ?? modelId}
          {model?.reasoning.length ? (
            <span className="text-muted-foreground/60">· {EFFORT_LABELS[rule.reasoning]}</span>
          ) : null}
          {!approved && <span className="text-destructive/80">· not approved</span>}
        </span>
      </button>
      {!first && (
        <button
          onClick={onMoveUp}
          aria-label="Move rule up"
          className="flex size-5 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity group-hover/rule:opacity-100 hover:text-foreground"
        >
          <ArrowUp className="size-3" />
        </button>
      )}
    </div>
  )
}

function RuleDialog({
  rule,
  rules,
  onSave,
  onDelete,
  onClose
}: {
  rule: RoutingRule | null
  rules: OrchestrationRules
  onSave: (r: RoutingRule) => void
  onDelete?: () => void
  onClose: () => void
}): React.JSX.Element {
  const catalog = useApp((s) => s.catalog)
  const [task, setTask] = useState(rule?.task ?? '')
  const [provider, setProvider] = useState<ProviderId>(rule?.provider ?? 'claude')
  const [model, setModel] = useState(rule?.model ?? '')
  const [reasoning, setReasoning] = useState<Reasoning>(rule?.reasoning ?? 'medium')

  const models = useMemo(
    () => (catalog?.[provider]?.models ?? []).filter((m) => modelApproved(rules, provider, m.id)),
    [catalog, provider, rules]
  )
  const effective = model || catalog?.[provider]?.defaultModel || ''
  const ladder = useMemo(
    () => (models.some((m) => m.id === effective) ? approvedLadder(rules, provider, effective) : []),
    [models, effective, rules, provider]
  )
  // Keep effort valid for the picked model (render-time adjust).
  if (ladder.length && !ladder.includes(reasoning)) setReasoning(ladder[0])

  const save = (): void => {
    if (!task.trim()) return
    onSave({
      id: rule?.id ?? Math.random().toString(36).slice(2, 10),
      task: task.trim(),
      provider,
      model,
      reasoning,
      enabled: rule?.enabled ?? true
    })
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{rule ? 'Edit rule' : 'Add rule'}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5 text-[13px]">
            When the task is…
            <Input
              autoFocus
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder="Bulk or mechanical work with a clear spec"
            />
          </label>
          <div className="flex items-center gap-2">
            <Select
              value={provider}
              onValueChange={(v) => {
                setProvider(v as ProviderId)
                setModel('')
              }}
            >
              <SelectTrigger size="sm" className="w-24">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(catalog ?? {}) as ProviderId[]).map((p) => (
                  <SelectItem key={p} value={p}>
                    {catalog?.[p].label ?? p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={model || '@default'}
              onValueChange={(v) => setModel(v === '@default' ? '' : v)}
            >
              <SelectTrigger size="sm" className="min-w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="@default">Provider default</SelectItem>
                {models.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {ladder.length > 1 && (
              <Select value={reasoning} onValueChange={(v) => setReasoning(v as Reasoning)}>
                <SelectTrigger size="sm" className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ladder.map((r) => (
                    <SelectItem key={r} value={r}>
                      {EFFORT_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="flex items-center justify-between pt-1">
            {onDelete ? (
              <Button variant="ghost" size="sm" onClick={onDelete} className="text-destructive">
                Delete
              </Button>
            ) : (
              <span />
            )}
            <Button size="sm" disabled={!task.trim()} onClick={save}>
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
