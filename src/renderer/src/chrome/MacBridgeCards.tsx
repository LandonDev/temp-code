import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { MacBridgeRequest } from '@server/shared/contract-macbridge'
import { LAYER } from '../lib/layers'
import { leafIds } from '../lib/layout'
import {
  decideMacBridge,
  quoteArgv,
  startMacBridge,
  useAllMacBridgeRequests,
  useMacBridgeRequests
} from '../lib/macBridge'
import { useWorkspaceTabs } from '../stores/workspace'
import { CircleAlert } from './icons'

/**
 * The Mac bridge's approval cards (docs/box.md "The Mac bridge"): a box
 * thread asked this Mac for a path outside what it shares, or to run a
 * command. Modelled on the approval-request controls (AgentTranscript's
 * ApprovalControls): Allow / Deny, plus the one remember the request
 * offers. Answered on the LOCAL link only (`macBridge.decide` is local).
 * MacBridgeThreadCards sits above the thread's composer; MacBridgeToasts
 * carries the requests of threads not on screen.
 */

const METHOD_TEXT: Record<MacBridgeRequest['method'], string> = {
  'mac.readFile': 'read',
  'mac.listDir': 'list',
  'mac.fetchFile': 'copy to the host',
  'mac.run': 'run'
}

function MacBridgeCard({
  request,
  showThread
}: {
  request: MacBridgeRequest
  showThread: boolean
}) {
  const [remember, setRemember] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const running = request.status === 'running'
  const decide = async (allow: boolean) => {
    setBusy(true)
    setError(null)
    try {
      await decideMacBridge(request.id, allow, remember)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const rememberLabel =
    request.kind === 'run'
      ? 'Allow this exact command for this thread'
      : request.folder
        ? `Allow ${request.folder} for this thread`
        : null
  const code = request.argv ? quoteArgv(request.argv) : (request.command ?? request.path ?? '')
  return (
    <div
      className="pointer-events-auto flex flex-col gap-2 rounded-lg border border-warning/30 bg-background-base/95 px-3 py-2.5 text-[12px] shadow-md glass-surface"
      role="group"
      aria-label="Mac bridge request"
      data-mac-bridge-request={request.id}
    >
      <div className="flex items-center gap-2">
        <CircleAlert className="size-3.5 shrink-0 text-warning" strokeWidth={1.75} />
        <span className="min-w-0 flex-1 truncate text-content">
          <span className="font-semibold">{request.hostName}</span> wants to{' '}
          {METHOD_TEXT[request.method]} on this Mac
          {showThread && request.threadTitle ? (
            <span className="text-content/50"> · {request.threadTitle}</span>
          ) : null}
        </span>
      </div>
      <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md bg-content/5 px-2 py-1.5 font-mono text-[11px] text-content/90">
        {code}
      </pre>
      {request.kind === 'run' ? (
        <div className="text-[11px] text-content/50">
          in <span className="font-mono">{request.cwd}</span>
          {request.timeoutMs ? ` · stops after ${Math.round(request.timeoutMs / 1000)} s` : ''}
        </div>
      ) : null}
      {running ? (
        <div className="flex items-center gap-2">
          <span className="flex-1 text-[11px] text-content/60">Running on this Mac…</span>
          <button
            type="button"
            disabled={busy}
            className="rounded-md bg-content/10 px-2.5 py-0.5 text-[11px] text-danger hover:bg-content/20"
            onClick={() => void decide(false)}
          >
            Stop
          </button>
        </div>
      ) : (
        <>
          {rememberLabel ? (
            <label className="flex items-center gap-2 text-[11px] text-content/70">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              <span className="min-w-0 truncate">{rememberLabel}</span>
            </label>
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
        </>
      )}
      {error ? <div className="text-[11px] text-danger">{error}</div> : null}
    </div>
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
      {requests.map((r) => (
        <MacBridgeCard key={r.id} request={r} showThread={false} />
      ))}
    </div>
  )
}

/** Requests of threads not in the active tab, as a stack at the bottom right. */
export function MacBridgeToasts() {
  useEffect(() => startMacBridge(), [])
  const requests = useAllMacBridgeRequests()
  const tabs = useWorkspaceTabs((s) => s.tabs)
  const activeTabId = useWorkspaceTabs((s) => s.activeTabId)
  const visible = useMemo(() => {
    const tab = tabs.find((t) => t.id === activeTabId)
    return new Set(tab ? leafIds(tab.layout) : [])
  }, [tabs, activeTabId])
  const hidden = requests.filter((r) => !visible.has(r.sessionId))
  if (hidden.length === 0) return null
  return createPortal(
    <div
      aria-live="polite"
      style={{ zIndex: LAYER.toast }}
      className="pointer-events-none fixed bottom-3 right-3 flex w-[min(380px,calc(100vw-24px))] flex-col gap-2"
    >
      {hidden.map((r) => (
        <MacBridgeCard key={r.id} request={r} showThread />
      ))}
    </div>,
    document.body
  )
}
