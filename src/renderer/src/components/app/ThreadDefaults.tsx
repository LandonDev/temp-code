import { useEffect, useMemo, useState } from 'react'
import type { ThreadDefaults } from '@shared/defaults'
import type { PermissionPolicy } from '@shared/events'
import type { ProviderId, Reasoning } from '@shared/catalog'
import { client } from '../../lib/client'
import { useApp } from '../../state/store'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Spinner } from '../ui/spinner'
import { SettingsGroup, SettingsPanel, SettingsRow } from './SettingsPanel'

/**
 * What a new thread starts with: provider, model, effort, and security.
 * Same scope model as the orchestration rules — global in Settings,
 * whole-object workspace overrides from the workspace menu. Saves on
 * every change.
 */

const EFFORT_LABELS: Record<Reasoning, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra'
}

const PERMISSION_LABELS: Record<PermissionPolicy, string> = {
  safe: 'Ask first',
  edits: 'Auto-edits',
  auto: 'Full access'
}

const PERMISSION_HINTS: Record<PermissionPolicy, string> = {
  safe: 'Every tool call asks before running.',
  edits: 'File edits run freely; commands still ask.',
  auto: 'Everything runs without asking.'
}

interface DefaultsPayload {
  defaults: ThreadDefaults
  overridden: boolean
}

export function ThreadDefaultsEditor({
  workspaceId
}: {
  workspaceId: string | null
}): React.JSX.Element {
  const catalog = useApp((s) => s.catalog)
  const [defaults, setDefaults] = useState<ThreadDefaults | null>(null)
  const [overridden, setOverridden] = useState(false)

  useEffect(() => {
    void client.request<DefaultsPayload>('defaults.get', { workspaceId }).then((p) => {
      setDefaults(p.defaults)
      setOverridden(p.overridden)
    })
  }, [workspaceId])

  const models = useMemo(
    () => (defaults ? (catalog?.[defaults.provider]?.models ?? []) : []),
    [catalog, defaults]
  )
  const effectiveModel = defaults
    ? defaults.model || catalog?.[defaults.provider]?.defaultModel || ''
    : ''
  const ladder = useMemo(
    () => models.find((m) => m.id === effectiveModel)?.reasoning ?? [],
    [models, effectiveModel]
  )

  if (!defaults || !catalog) {
    return (
      <div className="flex h-16 items-center justify-center">
        <Spinner className="size-4 text-muted-foreground/60" />
      </div>
    )
  }

  const push = (next: ThreadDefaults): void => {
    // Keep effort valid for the picked model.
    const nextModels = catalog[next.provider]?.models ?? []
    const nextEffective = next.model || catalog[next.provider]?.defaultModel || ''
    const nextLadder = nextModels.find((m) => m.id === nextEffective)?.reasoning ?? []
    if (nextLadder.length && !nextLadder.includes(next.reasoning)) {
      next = { ...next, reasoning: nextLadder[0] }
    }
    setDefaults(next)
    setOverridden(true)
    void client.request('defaults.set', { workspaceId, defaults: next })
  }

  const clearScope = (): void => {
    void client.request('defaults.set', { workspaceId, defaults: null }).then(() =>
      client.request<DefaultsPayload>('defaults.get', { workspaceId }).then((p) => {
        setDefaults(p.defaults)
        setOverridden(p.overridden)
      })
    )
  }

  return (
    <SettingsGroup
      title="New threads"
      hint={
        workspaceId
          ? overridden
            ? 'This workspace overrides the global defaults.'
            : 'Using the global defaults; any change creates a workspace override.'
          : 'Applied wherever a workspace has no override of its own.'
      }
      action={
        (overridden || !workspaceId) && (
          <button
            onClick={clearScope}
            className="shrink-0 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            {workspaceId ? 'Remove override' : 'Reset'}
          </button>
        )
      }
    >
      <SettingsPanel>
        <SettingsRow label="Model" description="The provider and model a thread opens on.">
          <Select
            value={defaults.provider}
            onValueChange={(v) => push({ ...defaults, provider: v as ProviderId, model: '' })}
          >
            <SelectTrigger size="sm" className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(catalog) as ProviderId[]).map((p) => (
                <SelectItem key={p} value={p}>
                  {catalog[p].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={defaults.model || '@default'}
            onValueChange={(v) => push({ ...defaults, model: v === '@default' ? '' : v })}
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
        </SettingsRow>

        {ladder.length > 1 && (
          <SettingsRow label="Reasoning" description="Effort level, from this model's ladder.">
            <Select
              value={defaults.reasoning}
              onValueChange={(v) => push({ ...defaults, reasoning: v as Reasoning })}
            >
              <SelectTrigger size="sm" className="w-32">
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
          </SettingsRow>
        )}

        <SettingsRow label="Security" description={PERMISSION_HINTS[defaults.permission]}>
          <Select
            value={defaults.permission}
            onValueChange={(v) => push({ ...defaults, permission: v as PermissionPolicy })}
          >
            <SelectTrigger size="sm" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(PERMISSION_LABELS) as PermissionPolicy[]).map((p) => (
                <SelectItem key={p} value={p}>
                  {PERMISSION_LABELS[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsPanel>
    </SettingsGroup>
  )
}
