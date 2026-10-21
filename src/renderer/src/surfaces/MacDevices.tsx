import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  deleteSimulatorConfirm,
  devicesSummary,
  holderText,
  type HostDevicesHost,
  type HostDevicesReport,
  type Phone,
  type Simulator
} from '@server/shared/contract-hostdevices'
import { ConfirmDialog, errorText } from '../chrome/ConfirmDialog'
import {
  deleteSimulator,
  openXcodeDevices,
  refreshHostDevicesHosts,
  shutdownSimulator,
  useHostDevices,
  useHostDevicesHosts
} from '../lib/hostDevices'

/**
 * Settings → Remote access → the devices a Mac is running (docs/box.md
 * "Devices on the Mac"): one block per Mac this pane can see (this Mac on
 * the desktop; the Macs linked to the host in web mode), under the Mac
 * bridge's host rows. A summary line, then a compact table: device, a state
 * dot, the thread that holds it, and the actions on hover (Shutdown, Delete
 * behind a confirm that names the holder; Open in Xcode for an iPhone).
 * The table is read every 30 s only while this block is on screen.
 */

export function MacDevicesSection({ onOpenSession }: { onOpenSession?: (sessionId: string) => void }) {
  const hosts = useHostDevicesHosts()
  useEffect(() => {
    void refreshHostDevicesHosts().catch(() => {})
    const t = window.setInterval(() => void refreshHostDevicesHosts().catch(() => {}), 15_000)
    return () => window.clearInterval(t)
  }, [])
  if (!hosts || hosts.length === 0) return null
  return (
    <>
      {hosts.map((host) => (
        <MacDevicesHost key={host.environmentId} host={host} onOpenSession={onOpenSession} />
      ))}
    </>
  )
}

function MacDevicesHost({
  host,
  onOpenSession
}: {
  host: HostDevicesHost
  onOpenSession?: (sessionId: string) => void
}) {
  const { report, error } = useHostDevices(host.environmentId)
  const id = host.environmentId
  return (
    <MacDevicesRow
      host={host}
      report={report}
      error={error}
      onOpenSession={onOpenSession}
      onShutdown={(udid) => shutdownSimulator(id, udid)}
      onDelete={(udid) => deleteSimulator(id, udid)}
      onOpenXcode={() => openXcodeDevices(id)}
    />
  )
}

export interface MacDevicesRowProps {
  host: HostDevicesHost
  report: HostDevicesReport | null
  error: string | null
  onOpenSession?: (sessionId: string) => void
  onShutdown: (udid: string) => Promise<unknown>
  onDelete: (udid: string) => Promise<unknown>
  onOpenXcode: () => Promise<unknown>
}

/** The block itself, with everything it shows passed in (the dom test renders this). */
export function MacDevicesRow({ host, report, error, onOpenSession, onShutdown, onDelete, onOpenXcode }: MacDevicesRowProps) {
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Simulator | null>(null)

  const run = useCallback(async (key: string, work: () => Promise<unknown>) => {
    setBusy(key)
    setFailed(null)
    try {
      await work()
    } catch (err) {
      setFailed(errorText(err))
    } finally {
      setBusy(null)
    }
  }, [])

  const title = host.local ? 'Devices on this Mac' : `Devices on ${host.name}`
  return (
    <div className="border-b border-content/5 py-3 last:border-b-0" data-devices={host.environmentId}>
      <div className="flex items-baseline gap-3">
        <div className="text-[13px] font-medium text-content">{title}</div>
        <div className="min-w-0 flex-1 truncate text-[12px] text-content/50" data-summary>
          {report ? devicesSummary(report) : error ? 'Not reachable' : 'Looking…'}
        </div>
      </div>
      {error && !report ? <p className="pt-1 text-[12px] text-danger">{error}</p> : null}
      {report ? (
        <>
          {report.simulators.length === 0 && report.phones.length === 0 ? (
            <p className="pt-2 text-[12px] text-content/40" data-empty>
              No simulators
            </p>
          ) : (
            <div className="mt-2 flex flex-col" role="table" aria-label={title}>
              <div
                role="row"
                className="grid grid-cols-[minmax(0,1fr)_7rem_minmax(0,10rem)_auto] gap-x-4 pb-1 text-[11px] text-content/40"
              >
                <span role="columnheader">Device</span>
                <span role="columnheader">State</span>
                <span role="columnheader">Held by</span>
                <span role="columnheader" className="sr-only">
                  Actions
                </span>
              </div>
              {report.simulators.length === 0 ? (
                <p className="py-1.5 text-[12px] text-content/40" data-empty>
                  No simulators
                </p>
              ) : null}
              {report.simulators.map((sim) => (
                <DeviceLine
                  key={sim.udid}
                  name={sim.name}
                  detail={sim.runtime}
                  state={simulatorState(sim)}
                  holder={sim.holder}
                  onOpenSession={onOpenSession}
                  busy={busy === sim.udid}
                  actions={
                    <>
                      {sim.state === 'booted' ? (
                        <Action onClick={() => void run(sim.udid, () => onShutdown(sim.udid))} disabled={busy !== null}>
                          Shutdown
                        </Action>
                      ) : null}
                      <Action danger onClick={() => setConfirm(sim)} disabled={busy !== null}>
                        Delete
                      </Action>
                    </>
                  }
                />
              ))}
              {report.phones.map((phone) => (
                <DeviceLine
                  key={phone.udid}
                  name={phone.model}
                  detail={`${phone.name} · ${phone.os}`}
                  state={phoneState(phone)}
                  holder={phone.holder}
                  onOpenSession={onOpenSession}
                  busy={busy === 'xcode'}
                  actions={
                    <Action onClick={() => void run('xcode', onOpenXcode)} disabled={busy !== null}>
                      Open in Xcode
                    </Action>
                  }
                />
              ))}
            </div>
          )}
          {report.xcode ? (
            <p className="pt-2 text-[12px] text-content/40">
              {report.xcode.name}
              {report.xcode.version ? ` ${report.xcode.version}` : ''}
              {report.xcode.from === 'developerDir' ? ' · DEVELOPER_DIR' : ''}
              {report.problems.length ? ` · ${report.problems.join(' · ')}` : ''}
            </p>
          ) : report.problems.length ? (
            <p className="pt-2 text-[12px] text-content/40">{report.problems.join(' · ')}</p>
          ) : null}
        </>
      ) : null}
      {failed ? <p className="pt-1 text-[12px] text-danger">{failed}</p> : null}
      {confirm ? (
        <ConfirmDialog
          {...deleteSimulatorConfirm(confirm)}
          confirmLabel="Delete"
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            const udid = confirm.udid
            setConfirm(null)
            await run(udid, () => onDelete(udid))
          }}
        />
      ) : null}
    </div>
  )
}

type Tone = 'on' | 'off' | 'between'
interface LineState {
  tone: Tone
  text: string
}

const simulatorState = (sim: Simulator): LineState => {
  if (sim.state === 'booted')
    return { tone: 'on', text: sim.cpu !== undefined ? `Booted · ${Math.round(sim.cpu)}% CPU` : 'Booted' }
  if (sim.state === 'shutdown') return { tone: 'off', text: 'Shutdown' }
  return { tone: 'between', text: sim.stateText ?? 'Changing' }
}

const phoneState = (phone: Phone): LineState => {
  if (phone.connection === 'connected')
    return { tone: 'on', text: phone.transport ? `Connected · ${phone.transport}` : 'Connected' }
  if (phone.connection === 'paired') return { tone: 'off', text: 'Paired' }
  return { tone: 'off', text: 'Unavailable' }
}

const DOT: Record<Tone, string> = {
  on: 'bg-success',
  between: 'bg-warning',
  off: 'bg-content/25'
}

function DeviceLine({
  name,
  detail,
  state,
  holder,
  onOpenSession,
  busy,
  actions
}: {
  name: string
  detail: string
  state: LineState
  holder: Simulator['holder']
  onOpenSession?: (sessionId: string) => void
  busy: boolean
  actions: ReactNode
}) {
  return (
    <div
      role="row"
      className="group grid min-h-7 grid-cols-[minmax(0,1fr)_7rem_minmax(0,10rem)_auto] items-center gap-x-4 border-t border-content/5 py-1.5 text-[12px]"
    >
      <span role="cell" className="min-w-0 truncate text-content" title={`${name} · ${detail}`}>
        {name}
        <span className="text-content/40">{` · ${detail}`}</span>
      </span>
      <span role="cell" className="flex items-center gap-1.5 text-content/60">
        <span aria-hidden className={`size-2 shrink-0 rounded-full ${DOT[state.tone]}`} data-tone={state.tone} />
        <span className="truncate">{state.text}</span>
      </span>
      <span role="cell" className="min-w-0 truncate text-content/60" data-holder>
        {holder ? (
          onOpenSession ? (
            <button
              type="button"
              className="max-w-full truncate text-content/70 hover:text-content hover:underline"
              onClick={() => onOpenSession(holder.sessionId)}
              title={holderText(holder)}
            >
              {holderText(holder)}
            </button>
          ) : (
            holderText(holder)
          )
        ) : (
          <span className="text-content/30">—</span>
        )}
      </span>
      <span
        role="cell"
        className={`flex items-center justify-end gap-1 transition-opacity duration-150 ease-out motion-reduce:transition-none ${
          busy ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'
        }`}
      >
        {actions}
      </span>
    </div>
  )
}

function Action({
  onClick,
  disabled,
  danger,
  children
}: {
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`pressable rounded-md px-1.5 py-0.5 text-[12px] ${
        danger ? 'text-danger hover:bg-danger/10' : 'text-content/60 hover:bg-content/10 hover:text-content'
      } disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent`}
    >
      {children}
    </button>
  )
}
