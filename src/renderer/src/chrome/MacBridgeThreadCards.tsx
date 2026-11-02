import { useEffect, useMemo, useState } from 'react'
import type { MacBridgeRequest } from '@server/shared/contract-macbridge'
import { Button } from '../components/ui/button'
import { Checkbox } from '../components/ui/checkbox'
import { Facts } from '../surfaces/settings/hosts/Facts'
import { decideMacBridge, queueOf, startMacBridge, useMacBridgeRequests } from '../lib/macBridge'
import { loadMacBridgeRules, useRunRemember } from '../lib/macBridgeRules'
import { CircleAlert } from './icons'
import { requestCode, requestFacts, requestTitle } from './MacBridgeCards'
import { RunRememberSelect } from './MacBridgeRemember'

/**
 * A box thread's waiting Mac bridge card above its composer (the rules in
 * MacBridgeCards.tsx). Its own lazy chunk (`macBridgeChunk`,
 * surfaces/chunks.ts), mounted only while the thread has a request waiting.
 */

const CARD_CLASS = 'flex flex-col gap-2 rounded-xl border border-border bg-card px-3 py-2.5 text-[13px]'

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
      <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg [--scrollbar-inset:var(--radius-lg)] bg-muted/40 px-2.5 py-1.5 font-mono text-xs text-foreground">
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
