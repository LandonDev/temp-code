import { useEffect, useState } from 'react'
import type { MacBridgeRequest } from '@server/shared/contract-macbridge'
import { heldLine, startMacBridge, stopMacBridgeAll, useMacBridgeRunning } from '../lib/macBridge'
import { requestCode } from './MacBridgeCards'

/**
 * Every command running on this Mac for a host or a thread, quiet ones
 * included, each with Stop: the quiet trace in Settings → Remote access →
 * Mac bridge and in a thread's "Mac approvals…" dialog. A command the load
 * guard holds (docs/box.md "The load guard") is a row here too, after the
 * running ones, with its place instead of a thread name; its Stop takes it
 * out of the line. Nothing here opens by itself.
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
  const waiting = inFlight.length - running
  return (
    <div className="flex flex-col gap-1.5" data-mac-bridge-running-list={inFlight.length}>
      <div className="flex items-center gap-3 text-[12px] text-content/60">
        <span className="min-w-0 flex-1 tabular-nums">{countLine(running, waiting, hostName)}</span>
        {inFlight.length > 1 ? (
          <button
            type="button"
            className="pressable shrink-0 rounded-md px-2 py-0.5 text-[11px] text-danger hover:bg-danger/10"
            onClick={() => void stop(inFlight)}
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
        >
          <span
            className="min-w-0 flex-1 truncate font-mono text-[12px] text-content/80"
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
          <button
            type="button"
            className="pressable shrink-0 rounded-md border border-content/10 px-2 py-0.5 text-[11px] text-danger hover:border-danger/40 hover:bg-danger/10"
            onClick={() => void stop([r])}
          >
            Stop
          </button>
        </div>
      ))}
      {error ? <p className="text-[11px] text-danger">{error}</p> : null}
    </div>
  )
}

/** "2 commands running on this Mac from box · 1 waiting"; with nothing running, "1 command waiting for this Mac". */
export function countLine(running: number, waiting: number, hostName?: string): string {
  const from = hostName ? ` from ${hostName}` : ''
  const noun = (n: number) => (n === 1 ? 'command' : 'commands')
  if (running === 0) return `${waiting} ${noun(waiting)} waiting for this Mac${from}`
  const base = `${running} ${noun(running)} running on this Mac${from}`
  return waiting ? `${base} · ${waiting} waiting` : base
}
