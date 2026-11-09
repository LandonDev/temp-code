import { useEffect, useMemo, useRef } from 'react'
import { loadToast } from './toastSync'
import type { MacBridgeRequest } from '@server/shared/contract-macbridge'
import { Facts } from '../surfaces/settings/hosts/Facts'
import { leafIds } from '../lib/layout'
import {
  decideMacBridge,
  queueOf,
  quoteArgv,
  startMacBridge,
  useAllMacBridgeRequests,
  type MacBridgeQueue
} from '../lib/macBridge'
import { startMacBridgeRules } from '../lib/macBridgeRules'
import { useWorkspaceTabs } from '../stores/workspace'

/**
 * The Mac bridge's approval cards (docs/box.md "The Mac bridge"): a box
 * thread asked this Mac for a path outside what it shares, or to run a
 * command. Modelled on the approval-request controls (AgentTranscript's
 * ApprovalControls): Allow / Deny, plus the one remember the request
 * offers. Answered on the LOCAL link only (`macBridge.decide` is local).
 * MacBridgeThreadCards (MacBridgeThreadCards.tsx, its own lazy chunk) sits
 * above the thread's composer; MacBridgeToasts carries the requests of
 * threads not on screen as sonner toasts.
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
  'mac.writeFile': 'write a file',
  'mac.computer': 'use'
}

/** A command as the person agreed to it: argv quoted, or the command string; a computer card's acting steps, one a line. */
export const requestCode = (request: MacBridgeRequest): string =>
  request.kind === 'computer'
    ? (request.computer?.actions ?? []).join('\n')
    : request.argv
      ? quoteArgv(request.argv)
      : (request.command ?? request.path ?? '')

/** A computer request's steps are words, not code: they read in the text face. */
export const requestIsCode = (request: MacBridgeRequest): boolean => request.kind !== 'computer'

/** "box wants to run on this Mac", "box wants to use TextEdit on this Mac": the line a card and a toast lead with. */
export const requestTitle = (request: MacBridgeRequest): string =>
  request.kind === 'computer'
    ? `${request.hostName} wants to use ${request.computer?.app || 'an app'} on this Mac`
    : `${request.hostName} wants to ${METHOD_TEXT[request.method]}${request.interactive ? ' interactively' : ''} on this Mac`

/** A live computer session as its row names it: "Using TextEdit, window "Untitled"". */
export const computerSessionLine = (request: MacBridgeRequest): string => {
  const app = request.computer?.app || 'an app'
  const window = request.computer?.window
  return window ? `Using ${app}, window ${JSON.stringify(window)}` : `Using ${app}`
}

/** A run's cwd, its timeout and whether stdin stays open; a write's mode and size; a computer card's window. */
export function requestFacts(request: MacBridgeRequest): string[] {
  if (request.kind === 'computer') return request.computer?.window ? [`window ${JSON.stringify(request.computer.window)}`] : []
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
          <span className={`block max-h-32 overflow-auto whitespace-pre-wrap text-xs ${requestIsCode(request) ? 'break-all font-mono' : 'break-words'}`}>
            {requestCode(request)}
          </span>
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
