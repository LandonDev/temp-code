import { useEffect, useState } from 'react'
import { TURN_PASS_OFF, passEnabled, type TurnPass } from '@shared/turnpass'
import { client } from '../../lib/client'
import { Switch } from '../ui/switch'
import { Spinner } from '../ui/spinner'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SettingsGroup, SettingsPanel, SettingsRow } from './SettingsPanel'

/**
 * The workspace's completed-turn setting: what a thread's model does after
 * each turn settles. The three parts mix freely — verify, build, and
 * commit (optionally pushing) — and run as one pass before queued
 * messages.
 */

const COMMIT_LABELS: Record<TurnPass['commit'], string> = {
  off: 'Off',
  commit: 'Commit',
  push: 'Commit & push'
}

export function TurnPassFields({
  value,
  onChange
}: {
  value: TurnPass
  onChange: (next: TurnPass) => void
}): React.JSX.Element {
  return (
    <SettingsPanel>
      <SettingsRow label="Verify" description="Run the project's checks and fix what fails.">
        <Switch checked={value.verify} onChange={(verify) => onChange({ ...value, verify })} />
      </SettingsRow>
      <SettingsRow label="Build" description="Create a build and say where it landed.">
        <Switch checked={value.build} onChange={(build) => onChange({ ...value, build })} />
      </SettingsRow>
      <SettingsRow label="Commit" description="Commit the turn's changes to the branch.">
        <Select
          value={value.commit}
          onValueChange={(commit) => onChange({ ...value, commit: commit as TurnPass['commit'] })}
        >
          <SelectTrigger size="sm" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(COMMIT_LABELS) as TurnPass['commit'][]).map((c) => (
              <SelectItem key={c} value={c}>
                {COMMIT_LABELS[c]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>
    </SettingsPanel>
  )
}

/** Self-loading editor for the workspace settings page. */
export function TurnPassEditor({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const [pass, setPass] = useState<TurnPass | null | undefined>(undefined)

  useEffect(() => {
    void client
      .request<TurnPass | null>('turnpass.get', { workspaceId })
      .then((p) => setPass(p ?? TURN_PASS_OFF))
  }, [workspaceId])

  const push = (next: TurnPass): void => {
    setPass(next)
    void client.request('turnpass.set', {
      workspaceId,
      pass: passEnabled(next) ? next : null
    })
  }

  return (
    <SettingsGroup
      title="Completed turn"
      hint="After a turn settles, implementation and orchestration threads run these before anything queued."
    >
      {pass === undefined ? (
        <div className="flex h-16 items-center justify-center">
          <Spinner className="size-4 text-muted-foreground/60" />
        </div>
      ) : (
        <TurnPassFields value={pass ?? TURN_PASS_OFF} onChange={push} />
      )}
    </SettingsGroup>
  )
}
