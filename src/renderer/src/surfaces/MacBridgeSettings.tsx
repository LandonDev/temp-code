import { useCallback, useEffect, useState } from 'react'
import {
  MAC_BRIDGE_MAX_RUNNING_CAP,
  MAC_BRIDGE_MAX_THREADS_CAP,
  trimNumber,
  type MacBridgeHostPolicy,
  type MacBridgeLoad,
  type MacBridgePolicy
} from '@server/shared/contract-macbridge'
import { errorText } from '../chrome/ConfirmDialog'
import { DeployDriftMark } from '../chrome/DeployDrift'
import { MacBridgeRunningList } from '../chrome/MacBridgeRunning'
import { MacBridgeRememberedSection } from '../chrome/MacBridgeRemember'
import { MacDevicesSection } from './MacDevices'
import { pickFolder } from '../lib/fs'
import {
  refreshMacBridgeHosts,
  refreshMacBridgeLoad,
  setMacBridgeLimits,
  setMacBridgeLoadLimit,
  setMacBridgePolicy,
  setMacBridgeShared,
  setMacBridgeShowRunning,
  useMacBridgeHosts,
  useMacBridgeLoad
} from '../lib/macBridge'
import { isWebMode } from '../lib/nativeWeb'
import { Heading, Input, Row, SecondaryButton, Segmented, Toggle } from './settingsBits'

/**
 * Settings → Remote access → Mac bridge (docs/box.md "The Mac bridge"): per
 * saved host, what its threads may do on this Mac (off | read | read and
 * run | full access) and which folders they read without asking. Everything
 * else (under full access: keys, credentials and the folders above home),
 * and every command not remembered, is asked on this Mac. Beside the policy,
 * "Show running commands" says whether a command admitted without a prompt
 * (remembered, or from a thread in full access on its box) shows as a card:
 * off by default under full access, on otherwise. Off, the only trace is the
 * running list here, with Stop per command. The load guard (docs/box.md "The
 * load guard") has its figures here too: per host, how many commands and
 * jobs may run at once and how many Mac-local threads it may start, with
 * what runs and waits now; once for the Mac, the one-minute load, the cores
 * and the limit over which new commands wait. Under the host rows, the devices
 * a Mac is running (MacDevices.tsx): this Mac's on the desktop; in web mode,
 * where the browser bundle has no Mac to share and the bridge rows stay away,
 * the Macs linked to the host.
 */

const POLICIES: { value: MacBridgePolicy; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'read', label: 'Read' },
  { value: 'read+run', label: 'Read and run' },
  { value: 'full', label: 'Full access' }
]

/** The line under a host's policy, for the levels that need one. */
const POLICY_NOTES: Partial<Record<MacBridgePolicy, string>> = {
  full: 'Any file on this Mac except keys and credentials; a command asks unless remembered or from a thread in full access.'
}

export function MacBridgeSettings({ onOpenSession }: { onOpenSession?: (sessionId: string) => void } = {}) {
  const hosts = useMacBridgeHosts()
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useMacBridgeLoad()

  const refresh = useCallback(async () => {
    try {
      await refreshMacBridgeHosts()
      setLoaded(true)
    } catch {
      setLoaded(false) // an older server: the section stays away
      return
    }
    try {
      await refreshMacBridgeLoad()
    } catch {
      // A server without the load guard: the load line stays away.
    }
  }, [])
  useEffect(() => {
    void refresh()
    const t = window.setInterval(() => void refresh(), 5000)
    return () => window.clearInterval(t)
  }, [refresh])

  const run = async (work: () => Promise<void>) => {
    setError(null)
    try {
      await work()
    } catch (err) {
      setError(errorText(err))
    }
  }

  if (isWebMode()) return <MacDevicesSection onOpenSession={onOpenSession} />
  if (!loaded) return null
  return (
    <>
      <Heading title="Mac bridge" />
      <p className="pb-2 text-[12px] leading-relaxed text-content/50">
        {"Threads on a host may read files on this Mac, copy them over and run commands here, as each host's setting allows. " +
          "Shared folders and this Mac's projects read without asking; any other path, and every command, waits for you here. " +
          'No phone, host or key can answer for you.'}
      </p>
      {error ? <p className="pb-2 text-[12px] text-danger">{error}</p> : null}
      {load ? <LoadLine load={load} run={run} /> : null}
      {hosts.length === 0 ? (
        <p className="py-3 text-[12px] text-content/40">
          No host yet: pair one with an admin key in Settings → Environments.
        </p>
      ) : (
        hosts.map((host) => <HostRow key={host.environmentId} host={host} run={run} />)
      )}
      <MacDevicesSection onOpenSession={onOpenSession} />
      <MacBridgeRememberedSection />
    </>
  )
}

function HostRow({
  host,
  run
}: {
  host: MacBridgeHostPolicy
  run: (work: () => Promise<void>) => Promise<void>
}) {
  const [path, setPath] = useState('')
  const add = (folder: string) =>
    run(() => setMacBridgeShared(host.environmentId, [...host.shared, folder]))
  const remove = (folder: string) =>
    run(() =>
      setMacBridgeShared(
        host.environmentId,
        host.shared.filter((f) => f !== folder)
      )
    )
  const browse = async () => {
    const picked = await pickFolder('Share a folder with this host')
    if (picked) await add(picked)
  }
  return (
    <div className="border-b border-content/5 pb-3 last:border-b-0">
      <Row
        label={host.name}
        description={
          host.registered
            ? 'Connected: its threads can reach this Mac.'
            : 'Not connected right now.'
        }
      >
        <DeployDriftMark environmentId={host.environmentId} />
        <Segmented
          label={`What ${host.name} may do on this Mac`}
          value={host.policy}
          options={POLICIES}
          onChange={(policy) => void run(() => setMacBridgePolicy(host.environmentId, policy))}
        />
      </Row>
      {POLICY_NOTES[host.policy] ? (
        <p className="pb-2 pl-1 text-[12px] text-content/50">{POLICY_NOTES[host.policy]}</p>
      ) : null}
      {host.policy === 'read+run' || host.policy === 'full' ? (
        <div className="flex flex-col gap-2 pb-2 pl-1">
          <div className="flex items-center gap-3">
            <span className="min-w-0 flex-1 text-[12px] text-content/60">
              Show running commands
              <span className="text-content/40">
                {' · '}
                {host.showRunning
                  ? 'a command allowed without asking shows as a running card'
                  : 'a command allowed without asking shows only here, with Stop'}
              </span>
            </span>
            <Toggle
              label={`Show commands running from ${host.name}`}
              on={host.showRunning}
              onChange={(on) => void run(() => setMacBridgeShowRunning(host.environmentId, on))}
            />
          </div>
          <MacBridgeRunningList environmentId={host.environmentId} hostName={host.name} />
        </div>
      ) : null}
      <div className="flex items-center gap-3 pb-2 pl-1" data-mac-bridge-caps={host.environmentId}>
        <span className="min-w-0 flex-1 truncate text-[12px] tabular-nums text-content/60">
          {usageNow(host)}
        </span>
        <span className="text-[12px] text-content/40">At once</span>
        {host.policy === 'read+run' || host.policy === 'full' ? (
          <label className="flex items-center gap-1.5 text-[12px] text-content/40">
            <CapField
              label={`Commands and jobs running at once from ${host.name}`}
              value={host.maxRunning}
              min={1}
              max={MAC_BRIDGE_MAX_RUNNING_CAP}
              onCommit={(n) =>
                void run(() => setMacBridgeLimits(host.environmentId, { maxRunning: n }))
              }
            />
            running
          </label>
        ) : null}
        <label className="flex items-center gap-1.5 text-[12px] text-content/40">
          <CapField
            label={`Threads ${host.name} may start on this Mac at once`}
            value={host.maxThreads}
            min={0}
            max={MAC_BRIDGE_MAX_THREADS_CAP}
            onCommit={(n) =>
              void run(() => setMacBridgeLimits(host.environmentId, { maxThreads: n }))
            }
          />
          threads
        </label>
      </div>
      {host.policy !== 'off' ? (
        <div className="flex flex-col gap-1.5 pl-1">
          <div className="text-[12px] text-content/60">Shared folders (read without asking)</div>
          {host.shared.length === 0 ? (
            <div className="text-[12px] text-content/40">
              {host.policy === 'full'
                ? 'None: full access reads everywhere except keys and credentials.'
                : "None: every read outside this Mac's projects asks."}
            </div>
          ) : null}
          {host.shared.map((folder) => (
            <div key={folder} className="flex items-center gap-3">
              <span
                className="min-w-0 flex-1 truncate font-mono text-[12px] text-content/80"
                title={folder}
              >
                {folder}
              </span>
              <SecondaryButton danger onClick={() => void remove(folder)}>
                Remove
              </SecondaryButton>
            </div>
          ))}
          <div className="flex items-center gap-2 pt-1">
            <Input
              value={path}
              placeholder="/Users/you/Documents/shared"
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && path.trim()) void add(path.trim()).then(() => setPath(''))
              }}
              className="flex-1"
            />
            <SecondaryButton
              disabled={!path.trim()}
              onClick={() => void add(path.trim()).then(() => setPath(''))}
            >
              Add
            </SecondaryButton>
            <SecondaryButton onClick={() => void browse()}>Choose…</SecondaryButton>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** "1 running · 2 waiting · 1 thread": what the host has on this Mac right now; "Nothing running" when idle. */
export function usageNow(host: Pick<MacBridgeHostPolicy, 'running' | 'held' | 'threads'>): string {
  const parts: string[] = []
  if (host.running) parts.push(`${host.running} running`)
  if (host.held) parts.push(`${host.held} waiting`)
  if (host.threads) parts.push(`${host.threads} ${host.threads === 1 ? 'thread' : 'threads'}`)
  return parts.length ? parts.join(' · ') : 'Nothing running'
}

/** A small whole-number field that commits on blur or Enter and snaps back to the value when the text is not a number in range. */
function CapField({
  label,
  value,
  min,
  max,
  onCommit
}: {
  label: string
  value: number
  min: number
  max: number
  onCommit: (n: number) => void
}) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = () => {
    const n = Number(text.trim())
    if (Number.isInteger(n) && n >= min && n <= max && n !== value) onCommit(n)
    else setText(String(value))
  }
  return (
    <Input
      aria-label={label}
      inputMode="numeric"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setText(String(value))
      }}
      className="w-12 text-right tabular-nums"
    />
  )
}

/**
 * The Mac's one-minute load beside its cores, and the limit over which new
 * commands and jobs wait (2 × cores until typed; an empty field follows the
 * cores again). The words carry the state: "holding new commands" while the
 * guard holds, and the figure it waits for.
 */
function LoadLine({
  load,
  run
}: {
  load: MacBridgeLoad
  run: (work: () => Promise<void>) => Promise<void>
}) {
  const [text, setText] = useState(load.pinned ? trimNumber(load.limit) : '')
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!editing) setText(load.pinned ? trimNumber(load.limit) : '')
  }, [load.limit, load.pinned, editing])
  const commit = () => {
    setEditing(false)
    const raw = text.trim()
    if (raw === '') {
      if (load.pinned) void run(() => setMacBridgeLoadLimit(null))
      return
    }
    const n = Number(raw)
    if (Number.isFinite(n) && n > 0 && n <= 10_000 && n !== load.limit)
      void run(() => setMacBridgeLoadLimit(n))
    else setText(load.pinned ? trimNumber(load.limit) : '')
  }
  return (
    <div
      className="flex items-center gap-3 pb-3"
      data-mac-bridge-load={load.busy ? 'holding' : 'ok'}
    >
      <span className="min-w-0 flex-1 truncate text-[12px] text-content/60">
        <span className="tabular-nums">Load {load.load.toFixed(1)}</span>
        <span className="tabular-nums text-content/40">
          {' · '}
          {load.cores} cores
          {' · '}
          {load.busy ? (
            <span className="text-warning">
              holding new commands until under {trimNumber(load.resumeBelow)}
            </span>
          ) : (
            <>new commands wait over</>
          )}
        </span>
      </span>
      <label className="flex items-center gap-1.5 text-[12px] text-content/40">
        <Input
          aria-label="Load limit"
          inputMode="decimal"
          value={text}
          placeholder={trimNumber(load.limit)}
          onFocus={() => setEditing(true)}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') {
              setText(load.pinned ? trimNumber(load.limit) : '')
              ;(e.target as HTMLInputElement).blur()
            }
          }}
          className="w-14 text-right tabular-nums"
        />
        limit
      </label>
    </div>
  )
}
