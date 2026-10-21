import { useEffect, useState } from 'react'
import type { MacBridgeRequest } from '@server/shared/contract-macbridge'
import { heldLine, startMacBridge, stopMacBridgeAll, useMacBridgeRunning } from '../lib/macBridge'
import { requestCode } from './MacBridgeCards'
import { Pause } from './icons'

/**
 * Every command running on this Mac for a host or a thread, quiet ones
 * included, each with Stop: the quiet trace in Settings → Remote access →
 * Mac bridge and in a thread's "Mac approvals…" dialog. A command the load
 * guard holds (docs/box.md "The load guard") is a row here too, after the
 * running ones, with its place instead of a thread name; its Stop takes it
 * out of the line. A call a paused thread holds on its host (status
 * `paused`) is a row after those, with "Paused" where Stop would be: nothing
 * runs for it here. Nothing here opens by itself.
 */
export function MacBridgeRunningList({
  environmentId,
  sessionId,
  hostName
}: {
  environmentId?: string
  sessionId?: string
  /** Named in the count line when the list is one host's. */
  hostName?: string
}) {
  useEffect(() => startMacBridge(), [])
  const inFlight = useMacBridgeRunning({ environmentId, sessionId })
  const [error, setError] = useState<string | null>(null)
  const stop = async (requests: MacBridgeRequest[]) => {
    setError(null)
    try {
      await stopMacBridgeAll(requests)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  if (inFlight.length === 0) return null
  const running = inFlight.filter((r) => r.status === 'running').length
  const paused = inFlight.filter((r) => r.status === 'paused').length
  const waiting = inFlight.length - running - paused
  // Stop all reaches what runs or waits its turn here; a paused thread's calls are its host's to release or refuse.
  const stoppable = inFlight.filter((r) => r.status !== 'paused')
  return (
    <div
      className="flex flex-col gap-1.5"
      data-mac-bridge-running-list={inFlight.length}
      data-mac-bridge-paused-count={paused}
    >
      <div className="flex items-center gap-3 text-[12px] text-content/60">
        <span className="min-w-0 flex-1 tabular-nums">{countLine(running, waiting, hostName, paused)}</span>
        {stoppable.length > 1 ? (
          <button
            type="button"
            className="pressable shrink-0 rounded-md px-2 py-0.5 text-[11px] text-danger hover:bg-danger/10"
            onClick={() => void stop(stoppable)}
          >
            Stop all
          </button>
        ) : null}
      </div>
      {inFlight.map((r) => (
        <div
          key={r.id}
          className="flex items-center gap-3"
          data-mac-bridge-running-row={r.id}
          data-mac-bridge-held={r.status === 'held' ? r.held?.position : undefined}
          data-mac-bridge-row-status={r.status}
        >
          <span
            className={`min-w-0 flex-1 truncate font-mono text-[12px] ${r.status === 'paused' ? 'text-content/50' : 'text-content/80'}`}
            title={`${requestCode(r)} · in ${r.cwd ?? ''}`}
          >
            {requestCode(r)}
            {sessionId === undefined && r.threadTitle ? (
              <span className="font-sans text-content/40"> · {r.threadTitle}</span>
            ) : null}
          </span>
          {r.status === 'held' && r.held ? (
            <span className="shrink-0 text-[11px] tabular-nums text-content/40">
              {heldLine(r.held)}
            </span>
          ) : null}
          {r.status === 'paused' ? (
            // Held on its host while the thread is paused: the same slot as Stop, as a fact rather than a control.
            <span
              className="flex h-[22px] shrink-0 items-center gap-1 px-2 text-[11px] text-content/45"
              title="Held on its host until the thread continues; nothing is running on this Mac"
            >
              <Pause className="size-3" strokeWidth={1.75} aria-hidden="true" />
              Paused
            </span>
          ) : (
            <button
              type="button"
              className="pressable h-[22px] shrink-0 rounded-md border border-content/10 px-2 text-[11px] text-danger hover:border-danger/40 hover:bg-danger/10"
              onClick={() => void stop([r])}
            >
              Stop
            </button>
          )}
        </div>
      ))}
      {error ? <p className="text-[11px] text-danger">{error}</p> : null}
    </div>
  )
}

/**
 * "2 commands running on this Mac from box · 1 waiting · 1 paused"; with
 * nothing running, "1 command waiting for this Mac", or with only paused
 * ones, "2 calls paused with their thread".
 */
export function countLine(running: number, waiting: number, hostName?: string, paused = 0): string {
  const from = hostName ? ` from ${hostName}` : ''
  const noun = (n: number) => (n === 1 ? 'command' : 'commands')
  const pausedPart = paused ? ` · ${paused} paused` : ''
  if (running === 0 && waiting === 0)
    return `${paused} ${paused === 1 ? 'call' : 'calls'} paused with ${paused === 1 ? 'its' : 'their'} thread${from}`
  if (running === 0) return `${waiting} ${noun(waiting)} waiting for this Mac${from}${pausedPart}`
  const base = `${running} ${noun(running)} running on this Mac${from}`
  return `${waiting ? `${base} · ${waiting} waiting` : base}${pausedPart}`
}
