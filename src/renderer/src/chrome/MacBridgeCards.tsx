import { useEffect, useMemo, useRef, useState } from 'react'
import { loadToast } from './toastSync'
import type { MacBridgeRequest } from '@server/shared/contract-macbridge'
import { Button } from '../components/ui/button'
import { Checkbox } from '../components/ui/checkbox'
import { Facts } from '../surfaces/settings/hosts/Facts'
import { leafIds } from '../lib/layout'
import {
  decideMacBridge,
  queueOf,
  quoteArgv,
  startMacBridge,
  useAllMacBridgeRequests,
  useMacBridgeRequests,
  type MacBridgeQueue
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
 * carries the requests of threads not on screen as sonner toasts.
 *
 * Never a screenful: `queueOf` (lib/macBridge.ts) keeps one waiting card per
 * host with "and N more", decided in order. A card is only ever a decision:
 * a call that runs is a row of the thread's Activity section and of the
 * host's Mac bridge on Settings → Hosts, each with Stop.
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

const CARD_CLASS = 'flex flex-col gap-2 rounded-xl border border-border bg-card px-3 py-2.5 text-[13px]'

/** "box wants to run on this Mac": the line a card and a toast lead with. */
export const requestTitle = (request: MacBridgeRequest): string =>
  `${request.hostName} wants to ${METHOD_TEXT[request.method]}${request.interactive ? ' interactively' : ''} on this Mac`

/** A run's cwd, its timeout and whether stdin stays open; a write's mode and size. */
export function requestFacts(request: MacBridgeRequest): string[] {
  if (request.kind === 'run')
    return [
      `in ${request.cwd ?? ''}`,
      ...(request.timeoutMs ? [`stops after ${Math.round(request.timeoutMs / 1000)} s`] : []),
      ...(request.interactive ? ['interactive: stdin stays open, ends after 30 idle minutes'] : [])
    ]
  if (request.kind === 'write')
    return [
      request.writeMode ?? 'create',
      `${(request.bytes ?? 0).toLocaleString()} bytes`,
      ...(request.createsFolders ? ['creates the missing folders'] : [])
    ]
  return []
}

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
  const rememberLabel = request.kind !== 'run' && request.folder ? `Allow ${request.folder} for this thread` : null
  const facts = requestFacts(request)
  return (
    <div className={CARD_CLASS} role="group" aria-label="Mac bridge request" data-mac-bridge-request={request.id}>
      <div className="flex items-start gap-2">
        <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" strokeWidth={1.75} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-foreground">{requestTitle(request)}</div>
          {showThread && request.threadTitle ? (
            <div className="truncate text-xs text-muted-foreground">{request.threadTitle}</div>
          ) : null}
        </div>
        {more > 0 ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground" data-mac-bridge-more={more}>
            and {more} more
          </span>
        ) : null}
      </div>
      <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/40 px-2.5 py-1.5 font-mono text-xs text-foreground">
        {requestCode(request)}
      </pre>
      {facts.length ? <Facts parts={facts} className="text-xs text-muted-foreground" /> : null}
      {rememberLabel ? (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox checked={remember} onCheckedChange={(on) => setRemember(on === true)} />
          <span className="min-w-0 truncate">{rememberLabel}</span>
        </label>
      ) : null}
      {request.kind === 'run' ? (
        <RunRememberSelect request={request} value={runRemember.choice} onChange={runRemember.setChoice} />
      ) : null}
      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => void decide(true)}>
          Allow
        </Button>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void decide(false)}>
          Deny
        </Button>
      </div>
      {error ? <div className="text-xs text-destructive">{error}</div> : null}
    </div>
  )
}

/** Above a box thread's composer: that thread's waiting card. */
export function MacBridgeThreadCards({ environmentId, sessionId }: { environmentId: string; sessionId: string }) {
  useEffect(() => startMacBridge(), [])
  const requests = useMacBridgeRequests(environmentId, sessionId)
  const queue = useMemo(() => queueOf(requests), [requests])
  if (queue.pending.length === 0) return null
  return (
    <div className="flex flex-col gap-2 px-1 pb-2">
      {queue.pending.map((r) => (
        <MacBridgeCard key={r.id} request={r} more={queue.more[r.environmentId] ?? 0} showThread={false} />
      ))}
    </div>
  )
}

/**
 * The requests of threads not on screen, as sonner toasts: one for each
 * host's oldest waiting request, the whole command with its facts, (Allow, Deny; the remember choice is the thread
 * card's alone), updated as the queue moves and dismissed when nothing waits.
 * `shown` is the set of toast ids up now, kept by the caller.
 */
export function syncMacBridgeToasts(queue: MacBridgeQueue, shown: Set<string>): void {
  // sonner loads on the first toast (toastSync.ts), off the first paint.
  void loadToast().then((toast) => syncToasts(toast, queue, shown))
}

function syncToasts(toast: Awaited<ReturnType<typeof loadToast>>, queue: MacBridgeQueue, shown: Set<string>): void {
  const live = new Set<string>()
  for (const request of queue.pending) {
    // One toast per request, never one id reused per host: sonner's exit of an
    // answered toast would take the next request's update with it.
    const id = `mac-bridge:${request.id}`
    live.add(id)
    const more = queue.more[request.environmentId] ?? 0
    toast(requestTitle(request), {
      id,
      duration: Infinity,
      description: (
        <span className="flex min-w-0 flex-col gap-1" data-mac-bridge-toast={request.id}>
          <span className="block max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{requestCode(request)}</span>
          {requestFacts(request).length ? <Facts parts={requestFacts(request)} className="text-xs" /> : null}
          {request.threadTitle || more ? (
            <span className="truncate">{[request.threadTitle, more ? `and ${more} more` : ''].filter(Boolean).join(', ')}</span>
          ) : null}
        </span>
      ),
      action: { label: 'Allow', onClick: () => void decideMacBridge(request.id, true, false).catch(() => {}) },
      cancel: { label: 'Deny', onClick: () => void decideMacBridge(request.id, false, false).catch(() => {}) }
    })
  }
  for (const id of shown) if (!live.has(id)) toast.dismiss(id)
  shown.clear()
  for (const id of live) shown.add(id)
}

/** Keeps the toasts in step with the requests of threads not in the active tab. Renders nothing itself. */
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
  const hidden = useMemo(() => requests.filter((r) => !visible.has(r.sessionId)), [requests, visible])
  const queue = useMemo(() => queueOf(hidden), [hidden])
  const shown = useRef(new Set<string>())
  useEffect(() => syncMacBridgeToasts(queue, shown.current), [queue])
  useEffect(() => () => syncMacBridgeToasts({ pending: [], more: {} }, shown.current), [])
  return null
}
