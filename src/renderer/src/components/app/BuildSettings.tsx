import { useEffect, useRef, useState } from 'react'
import type { BuildConfig } from '@shared/build'
import { client } from '../../lib/client'
import { useApp } from '../../state/store'
import { cn } from '../../lib/utils'
import { Input } from '../ui/input'
import { Spinner } from '../ui/spinner'
import { SettingsGroup, SettingsPanel, SettingsRow } from './SettingsPanel'

/**
 * The workspace's build command (Build rail, and what the completed-turn
 * build step names). Placeholders show what the app detects from the
 * checkout; leaving both fields empty keeps that detection.
 */

export const BUILD_EMPTY: BuildConfig = { command: '', outputs: '' }

/** An override with no command means "inherit" — store nothing. */
export const buildOrNull = (c: BuildConfig | null): BuildConfig | null =>
  c && c.command.trim() ? { command: c.command.trim(), outputs: c.outputs.trim() } : null

export function BuildFields({
  value,
  onChange,
  detected,
  compact
}: {
  value: BuildConfig
  onChange: (next: BuildConfig) => void
  detected: BuildConfig | null
  /** narrow host (the project dialog): no descriptions, narrower inputs */
  compact?: boolean
}): React.JSX.Element {
  const input = cn('h-7 font-mono text-[11.5px]', compact ? 'w-52' : 'w-56')
  return (
    <SettingsPanel>
      <SettingsRow
        label="Command"
        description={compact ? undefined : 'Runs in the project checkout through your login shell.'}
      >
        <Input
          value={value.command}
          onChange={(e) => onChange({ ...value, command: e.target.value })}
          placeholder={detected?.command ?? 'e.g. mvn -B package'}
          spellCheck={false}
          className={input}
        />
      </SettingsRow>
      <SettingsRow
        label="Outputs"
        description={
          compact ? undefined : 'Globs for the files it produces, comma-separated; ! excludes.'
        }
      >
        <Input
          value={value.outputs}
          onChange={(e) => onChange({ ...value, outputs: e.target.value })}
          placeholder={detected?.outputs || 'e.g. target/*.jar'}
          spellCheck={false}
          className={input}
        />
      </SettingsRow>
    </SettingsPanel>
  )
}

/** Self-loading editor for the workspace settings page; saves as you type. */
export function BuildEditor({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const path = useApp((s) => s.workspaces.find((w) => w.id === workspaceId)?.path)
  const [config, setConfig] = useState<BuildConfig | undefined>(undefined)
  const [detected, setDetected] = useState<BuildConfig | null>(null)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    void client
      .request<BuildConfig | null>('build.get', { workspaceId })
      .then((c) => setConfig(c ?? BUILD_EMPTY))
    if (path) {
      void client
        .request<BuildConfig | null>('build.detect', { path })
        .then(setDetected)
        .catch(() => {})
    }
  }, [workspaceId, path])

  const push = (next: BuildConfig): void => {
    setConfig(next)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      void client.request('build.set', { workspaceId, config: buildOrNull(next) })
    }, 500)
  }

  return (
    <SettingsGroup
      title="Build"
      hint={
        detected
          ? 'Empty fields use what the checkout implies (shown as placeholders).'
          : 'What the Build rail runs. Projects can override this in their settings.'
      }
    >
      {config === undefined ? (
        <div className="flex h-16 items-center justify-center">
          <Spinner className="size-4 text-muted-foreground/60" />
        </div>
      ) : (
        <BuildFields value={config} onChange={push} detected={detected} />
      )}
    </SettingsGroup>
  )
}
