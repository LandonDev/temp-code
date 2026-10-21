import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { MacBridgeRequest } from '@server/shared/contract-macbridge'
import { LAYER } from '../lib/layers'
import { leafIds } from '../lib/layout'
import {
  decideMacBridge,
  queueOf,
  quoteArgv,
  startMacBridge,
  stopMacBridgeAll,
  useAllMacBridgeRequests,
  useMacBridgeRequests,
  type MacBridgeRunningGroup
} from '../lib/macBridge'
import { loadMacBridgeRules, startMacBridgeRules, useRunRemember } from '../lib/macBridgeRules'
import { useWorkspaceTabs } from '../stores/workspace'
import { CircleAlert } from './icons'
import { RunRememberSelect } from './MacBridgeRemember'

/**
 * The Mac bridge's approval cards (docs/box.md "The Mac bridge"): a box
 * thread asked this Mac for a path outside what it shares, or to run a
 * command. Modelled on the approval-request controls (AgentTranscript's
 * ApprovalControls): Allow / Deny, plus the one remember the request
 * offers. Answered on the LOCAL link only (`macBridge.decide` is local).
 * MacBridgeThreadCards sits above the thread's composer; MacBridgeToasts
 * carries the requests of threads not on screen.
 *
 * Never a screenful: `queueOf` (lib/macBridge.ts) keeps one waiting card per
 * host with "and N more", decided in order, and folds the running commands
 * into one line per host with Stop all. A quiet request (admitted without a
 * prompt while the host's "Show running commands" is off) gets no card at
 * all; Settings → Remote access → Mac bridge lists it, with Stop.
 */

const METHOD_TEXT: Record<MacBridgeRequest['method'], string> = {
  'mac.readFile': 'read',
  'mac.listDir': 'list',
  'mac.fetchFile': 'copy to the host',
  'mac.run': 'run',
  'mac.writeFile': 'write a file'
}

/** A command as the person agreed to it: argv quoted, or the command string. */
export const requestCode = (request: MacBridgeRequest): string =>
  request.argv ? quoteArgv(request.argv) : (request.command ?? request.path ?? '')

const CARD_CLASS =
  'pointer-events-auto flex flex-col gap-2 rounded-lg border border-warning/30 bg-background-base/95 px-3 py-2.5 text-[12px] shadow-md glass-surface'

function MacBridgeCard({
  request,
  more,
  showThread
}: {
  request: MacBridgeRequest
  /** Waiting behind this one from the same host. */
  more: number
  showThread: boolean
}) {
  const [remember, setRemember] = useState(false)
  const runRemember = useRunRemember(request)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const decide = async (allow: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const kept = request.kind === 'run' ? runRemember.remember : remember
      await decideMacBridge(request.id, allow, allow ? kept : false)
      if (allow && kept) void loadMacBridgeRules()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const rememberLabel =
    request.kind === 'run'
      ? null
      : request.folder
        ? `Allow ${request.folder} for this thread`
        : null
  return (
    <div
      className={CARD_CLASS}
      role="group"
      aria-label="Mac bridge request"
      data-mac-bridge-request={request.id}
    >
      <div className="flex items-center gap-2">
        <CircleAlert className="size-3.5 shrink-0 text-warning" strokeWidth={1.75} />
        <span className="min-w-0 flex-1 truncate text-content">
          <span className="font-semibold">{request.hostName}</span> wants to{' '}
          {METHOD_TEXT[request.method]}
          {request.interactive ? ' interactively' : ''} on this Mac
          {showThread && request.threadTitle ? (
            <span className="text-content/50"> · {request.threadTitle}</span>
          ) : null}
        </span>
        {more > 0 ? (
          <span
            className="shrink-0 text-[11px] text-content/50"
            data-mac-bridge-more={more}
          >
            and {more} more
          </span>
        ) : null}
      </div>
      <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md bg-content/5 px-2 py-1.5 font-mono text-[11px] text-content/90">
        {requestCode(request)}
      </pre>
      {request.kind === 'run' ? (
        <div className="text-[11px] text-content/50">
          in <span className="font-mono">{request.cwd}</span>
          {request.timeoutMs ? ` · stops after ${Math.round(request.timeoutMs / 1000)} s` : ''}
          {request.interactive
            ? ' · interactive: stdin stays open, ends after 30 idle minutes'
            : ''}
        </div>
      ) : null}
      {request.kind === 'write' ? (
        <div className="text-[11px] text-content/50">
          {request.writeMode ?? 'create'} · {(request.bytes ?? 0).toLocaleString()} bytes
          {request.createsFolders ? ' · creates the missing folders' : ''}
        </div>
      ) : null}
      {rememberLabel ? (
        <label className="flex items-center gap-2 text-[11px] text-content/70">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <span className="min-w-0 truncate">{rememberLabel}</span>
        </label>
      ) : null}
      {request.kind === 'run' ? (
        <RunRememberSelect
          request={request}
          value={runRemember.choice}
          onChange={runRemember.setChoice}
        />
      ) : null}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          className="rounded-md bg-content px-2.5 py-0.5 text-[11px] text-background-base hover:bg-content/70"
          onClick={() => void decide(true)}
        >
          Allow
        </button>
        <button
          type="button"
          disabled={busy}
          className="rounded-md bg-content/10 px-2.5 py-0.5 text-[11px] text-content/70 hover:bg-content/20"
          onClick={() => void decide(false)}
        >
          Deny
        </button>
      </div>
      {error ? <div className="text-[11px] text-danger">{error}</div> : null}
    </div>
  )
}

/** One host's running commands, folded: the command when there is one, the count past that, one Stop (all). */
function MacBridgeRunningLine({
  group,
  showThread
}: {
  group: MacBridgeRunningGroup
  showThread: boolean
}) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const one = group.requests.length === 1 ? group.requests[0] : null
  const stop = async () => {
    setBusy(true)
    setError(null)
    try {
      await stopMacBridgeAll(group.requests)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      className={CARD_CLASS}
      role="group"
      aria-label="Commands running on this Mac"
      data-mac-bridge-running={group.environmentId}
      data-mac-bridge-running-count={group.requests.length}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-content">
          {one ? (
            <>
              <span className="font-mono text-[11px] text-content/90" title={requestCode(one)}>
                {requestCode(one)}
              </span>
              <span className="text-content/60"> running from {group.hostName}</span>
              {showThread && one.threadTitle ? (
                <span className="text-content/50"> · {one.threadTitle}</span>
              ) : null}
            </>
          ) : (
            <>
              <span className="font-semibold">{group.requests.length} commands</span>
              <span className="text-content/60"> running from {group.hostName}</span>
            </>
          )}
        </span>
        <button
          type="button"
          disabled={busy}
          className="shrink-0 rounded-md bg-content/10 px-2.5 py-0.5 text-[11px] text-danger hover:bg-content/20"
          onClick={() => void stop()}
        >
          {one ? 'Stop' : 'Stop all'}
        </button>
      </div>
      {error ? <div className="text-[11px] text-danger">{error}</div> : null}
    </div>
  )
}

/** The queue as cards: the running lines first (short), then one waiting card per host. */
function MacBridgeQueueCards({
  requests,
  showThread
}: {
  requests: MacBridgeRequest[]
  showThread: boolean
}) {
  const queue = useMemo(() => queueOf(requests), [requests])
  return (
    <>
      {queue.running.map((g) => (
        <MacBridgeRunningLine key={g.environmentId} group={g} showThread={showThread} />
      ))}
      {queue.pending.map((r) => (
        <MacBridgeCard
          key={r.id}
          request={r}
          more={queue.more[r.environmentId] ?? 0}
          showThread={showThread}
        />
      ))}
    </>
  )
}

/** Above a box thread's composer: that thread's requests. */
export function MacBridgeThreadCards({
  environmentId,
  sessionId
}: {
  environmentId: string
  sessionId: string
}) {
  useEffect(() => startMacBridge(), [])
  const requests = useMacBridgeRequests(environmentId, sessionId)
  if (requests.length === 0) return null
  return (
    <div className="flex flex-col gap-2 px-1 pb-2">
      <MacBridgeQueueCards requests={requests} showThread={false} />
    </div>
  )
}

/** Requests of threads not in the active tab, as a stack at the bottom right. */
export function MacBridgeToasts() {
  useEffect(() => startMacBridge(), [])
  useEffect(() => startMacBridgeRules(), [])
  const requests = useAllMacBridgeRequests()
  const tabs = useWorkspaceTabs((s) => s.tabs)
  const activeTabId = useWorkspaceTabs((s) => s.activeTabId)
  const visible = useMemo(() => {
    const tab = tabs.find((t) => t.id === activeTabId)
    return new Set(tab ? leafIds(tab.layout) : [])
  }, [tabs, activeTabId])
  const hidden = useMemo(
    () => requests.filter((r) => !visible.has(r.sessionId)),
    [requests, visible]
  )
  if (hidden.length === 0) return null
  return createPortal(
    <div
      aria-live="polite"
      style={{ zIndex: LAYER.toast }}
      className="pointer-events-none fixed bottom-3 right-3 flex w-[min(380px,calc(100vw-24px))] flex-col gap-2"
    >
      <MacBridgeQueueCards requests={hidden} showThread />
    </div>,
    document.body
  )
}
