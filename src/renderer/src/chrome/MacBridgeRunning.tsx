import { useEffect, useState } from 'react'
import type { MacBridgeRequest } from '@server/shared/contract-macbridge'
import { heldParts, startMacBridge, stopMacBridgeAll, useMacBridgeRunning } from '../lib/macBridge'
import { requestCode } from './MacBridgeCards'
import { Button } from '../components/ui/button'
import { Row } from '../surfaces/settings/hosts/Group'
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip'
import { Facts } from '../surfaces/settings/hosts/Facts'
import { Pause } from './icons'

/**
 * Every command running on this Mac for a host or a thread, quiet ones
 * included, each a row with Stop: the quiet trace on Settings → Hosts under
 * the host's Mac bridge, and in a thread's "Mac approvals…" dialog. A
 * command the load guard holds (docs/box.md "The load guard") is a row
 * after the running ones, its place in line at the end instead of a thread
 * name; its Stop takes it out of the line. A call a paused thread holds on
 * its host (status `paused`) is a row after those, "Paused" where Stop would
 * be: nothing runs for it here. Nothing here opens by itself.
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
      className="flex flex-col"
      data-mac-bridge-running-list={inFlight.length}
      data-mac-bridge-paused-count={paused}
    >
      <div className="flex min-h-7 items-center gap-3 text-xs text-muted-foreground" data-mac-bridge-count>
        <Facts parts={countParts(running, waiting, hostName, paused)} className="min-w-0 flex-1" />
        {stoppable.length > 1 ? (
          <Button variant="destructive" size="xs" onClick={() => void stop(stoppable)}>
            Stop all
          </Button>
        ) : null}
      </div>
      {inFlight.map((r) => (
        <Row
          key={r.id}
          data-mac-bridge-running-row={r.id}
          data-mac-bridge-held={r.status === 'held' ? r.held?.position : undefined}
          data-mac-bridge-row-status={r.status}
          title={
            <span className={`block max-w-full truncate font-mono text-xs font-normal ${r.status === 'paused' ? 'text-muted-foreground' : ''}`}>
              {requestCode(r)}
            </span>
          }
          description={sessionId === undefined && r.threadTitle ? r.threadTitle : undefined}
        >
          {r.status === 'held' && r.held ? (
            <Facts parts={heldParts(r.held)} className="text-xs text-muted-foreground" />
          ) : null}
          {r.status === 'paused' ? (
            // Held on its host while the thread is paused: the same slot as Stop, as a fact rather than a control.
            <Tooltip>
              <TooltipTrigger
                render={<span className="flex h-6 cursor-default items-center gap-1 px-2 text-xs text-muted-foreground" />}
              >
                <Pause className="size-3" strokeWidth={1.75} aria-hidden="true" />
                Paused
              </TooltipTrigger>
              <TooltipContent>Held on its host until the thread continues; nothing runs on this Mac</TooltipContent>
            </Tooltip>
          ) : (
            <Button variant="destructive" size="xs" onClick={() => void stop([r])}>
              Stop
            </Button>
          )}
        </Row>
      ))}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  )
}

/**
 * The list's first line as facts: "2 commands running on this Mac from
 * box", "1 waiting", "1 paused"; with nothing running, "1 command waiting
 * for this Mac", or with only paused ones, "2 calls paused with their
 * thread".
 */
export function countParts(running: number, waiting: number, hostName?: string, paused = 0): string[] {
  const from = hostName ? ` from ${hostName}` : ''
  const noun = (n: number) => (n === 1 ? 'command' : 'commands')
  if (running === 0 && waiting === 0)
    return [`${paused} ${paused === 1 ? 'call' : 'calls'} paused with ${paused === 1 ? 'its' : 'their'} thread${from}`]
  const parts =
    running === 0
      ? [`${waiting} ${noun(waiting)} waiting for this Mac${from}`]
      : [`${running} ${noun(running)} running on this Mac${from}`, ...(waiting ? [`${waiting} waiting`] : [])]
  return paused ? [...parts, `${paused} paused`] : parts
}

