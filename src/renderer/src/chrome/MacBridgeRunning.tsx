import { useEffect, useState } from 'react'
import type { MacBridgeRequest } from '@server/shared/contract-macbridge'
import { startMacBridge, stopMacBridgeAll, useMacBridgeRunning } from '../lib/macBridge'
import { requestCode } from './MacBridgeCards'

/**
 * Every command running on this Mac for a host or a thread, quiet ones
 * included, each with Stop: the quiet trace in Settings → Remote access →
 * Mac bridge and in a thread's "Mac approvals…" dialog. Nothing here opens
 * by itself.
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
  const running = useMacBridgeRunning({ environmentId, sessionId })
  const [error, setError] = useState<string | null>(null)
  const stop = async (requests: MacBridgeRequest[]) => {
    setError(null)
    try {
      await stopMacBridgeAll(requests)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  if (running.length === 0) return null
  return (
    <div className="flex flex-col gap-1.5" data-mac-bridge-running-list={running.length}>
      <div className="flex items-center gap-3 text-[12px] text-content/60">
        <span className="min-w-0 flex-1">
          {running.length} {running.length === 1 ? 'command' : 'commands'} running on this Mac
          {hostName ? ` from ${hostName}` : ''}
        </span>
        {running.length > 1 ? (
          <button
            type="button"
            className="pressable shrink-0 rounded-md px-2 py-0.5 text-[11px] text-danger hover:bg-danger/10"
            onClick={() => void stop(running)}
          >
            Stop all
          </button>
        ) : null}
      </div>
      {running.map((r) => (
        <div key={r.id} className="flex items-center gap-3" data-mac-bridge-running-row={r.id}>
          <span
            className="min-w-0 flex-1 truncate font-mono text-[12px] text-content/80"
            title={`${requestCode(r)} · in ${r.cwd ?? ''}`}
          >
            {requestCode(r)}
            {sessionId === undefined && r.threadTitle ? (
              <span className="font-sans text-content/40"> · {r.threadTitle}</span>
            ) : null}
          </span>
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
