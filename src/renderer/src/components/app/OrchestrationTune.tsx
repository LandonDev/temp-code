import { useEffect, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import type { ConductOverride, OrchestrationRules, ThreadRules } from '@shared/rules'
import { DEFAULT_RULES } from '@shared/rules'
import { client } from '../../lib/client'
import { cn } from '../../lib/utils'
import { Switch } from '../ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger } from '../ui/select'

/**
 * Per-run orchestration tune, shared by the new-thread popover and the
 * plan's Start popover. The workspace/global rules from Settings stay the
 * DEFAULT: every row shows the inherited value quietly; touching a control
 * records an override for this one thread, marked with a reset affordance
 * so inherit is always one tap away (apple-design: agency + forgiveness).
 * Picking the default value again simply clears the override — the tune
 * never stores what Settings already says.
 */

type Conduct = OrchestrationRules['conduct']

const DELEGATION: { value: Conduct['delegation']; label: string }[] = [
  { value: 'strict', label: 'Strict' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'free', label: 'Free' }
]

const SWITCHES: { key: keyof Conduct; label: string }[] = [
  { key: 'selfEdit', label: 'Edit files itself' },
  { key: 'selfShell', label: 'Run shell itself' },
  { key: 'verifyResults', label: 'Verify agent reports' },
  { key: 'escalate', label: 'Escalate on weak output' },
  { key: 'useWorktrees', label: 'Worktree isolation' }
]

const PARALLEL_STEPS = [1, 2, 4, 8, 16, 0]
const TOTAL_STEPS = [10, 25, 50, 100, 0]

export function OrchestrationTune({
  workspaceId,
  value,
  onChange
}: {
  workspaceId: string | null
  value: ThreadRules
  /** a state setter — updates are functional so rapid changes never clobber */
  onChange: React.Dispatch<React.SetStateAction<ThreadRules>>
}): React.JSX.Element {
  // The inherited baseline these rows show until overridden.
  const [base, setBase] = useState<Conduct>(DEFAULT_RULES.conduct)
  useEffect(() => {
    let alive = true
    void client
      .request<{ rules: OrchestrationRules }>('rules.get', { workspaceId })
      .then((r) => alive && setBase(r.rules.conduct))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [workspaceId])

  const over = value.conduct ?? {}
  const effective = <K extends keyof Conduct>(k: K): Conduct[K] =>
    (over[k] as Conduct[K] | undefined) ?? base[k]

  const set = <K extends keyof Conduct>(k: K, v: Conduct[K]): void => {
    onChange((prev) => {
      const next: ConductOverride = { ...prev.conduct }
      if (v === base[k]) delete next[k]
      else next[k] = v
      return { ...prev, conduct: Object.keys(next).length ? next : undefined }
    })
  }

  const Row = ({
    k,
    label,
    children
  }: {
    k: keyof Conduct
    label: string
    children: React.ReactNode
  }): React.JSX.Element => {
    const overridden = k in over
    return (
      <div className="group/row flex h-8 items-center gap-2">
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[12.5px]',
            overridden ? 'text-foreground' : 'text-muted-foreground'
          )}
        >
          {label}
        </span>
        {overridden && (
          <button
            onClick={() => set(k, base[k])}
            title="Back to default"
            aria-label={`Reset ${label} to default`}
            className="flex size-5 items-center justify-center rounded text-muted-foreground/70 opacity-0 transition group-hover/row:opacity-100 hover:text-foreground active:scale-95"
          >
            <RotateCcw className="size-3" />
          </button>
        )}
        {children}
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      <textarea
        value={value.instructions ?? ''}
        onChange={(e) => {
          const text = e.target.value
          onChange((prev) => ({ ...prev, instructions: text || undefined }))
        }}
        placeholder="Custom instructions for this run…"
        rows={2}
        className="max-h-32 min-h-[52px] w-full resize-none rounded-lg border border-border/60 bg-background/40 px-2.5 py-2 text-[12.5px] leading-snug outline-none placeholder:text-muted-foreground/60 focus:border-border"
      />

      <p className="mt-3 mb-1 text-[10px] font-medium tracking-[0.08em] text-muted-foreground/60 uppercase">
        Rules · defaults from Settings
      </p>

      <Row k="delegation" label="Delegation">
        <span className="flex gap-0.5 rounded-md bg-secondary/60 p-0.5">
          {DELEGATION.map((o) => (
            <button
              key={o.value}
              onClick={() => set('delegation', o.value)}
              className={cn(
                'rounded px-1.5 py-0.5 text-[11px] transition-colors',
                effective('delegation') === o.value
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {o.label}
            </button>
          ))}
        </span>
      </Row>

      {SWITCHES.map((s) => (
        <Row key={s.key} k={s.key} label={s.label}>
          <Switch
            checked={effective(s.key) as boolean}
            onChange={(on) => set(s.key, on as Conduct[typeof s.key])}
            aria-label={s.label}
          />
        </Row>
      ))}

      <Row k="maxParallel" label="Parallel agents">
        <CountSelect
          steps={PARALLEL_STEPS}
          value={effective('maxParallel')}
          onPick={(n) => set('maxParallel', n)}
        />
      </Row>
      <Row k="maxAgents" label="Total per thread">
        <CountSelect
          steps={TOTAL_STEPS}
          value={effective('maxAgents')}
          onPick={(n) => set('maxAgents', n)}
        />
      </Row>
    </div>
  )
}

function CountSelect({
  steps,
  value,
  onPick
}: {
  steps: number[]
  value: number
  onPick: (n: number) => void
}): React.JSX.Element {
  // A stored value outside the ladder (typed in Settings) still shows.
  const options = steps.includes(value) ? steps : [...steps, value].sort((a, b) => a - b || a)
  return (
    <Select value={String(value)} onValueChange={(v) => onPick(Number(v))}>
      <SelectTrigger size="sm" className="gap-1 px-1.5 tabular-nums">
        {value === 0 ? 'Unlimited' : value}
      </SelectTrigger>
      <SelectContent>
        {options.map((n) => (
          <SelectItem key={n} value={String(n)}>
            {n === 0 ? 'Unlimited' : n}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** How many settings this tune overrides — the popover rows caption it. */
export function tuneSummary(t: ThreadRules): string | null {
  const n = Object.keys(t.conduct ?? {}).length
  const parts = [
    n > 0 ? `${n} override${n > 1 ? 's' : ''}` : null,
    t.instructions?.trim() ? 'instructions' : null
  ].filter(Boolean)
  return parts.length ? parts.join(' + ') : null
}
