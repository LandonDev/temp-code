import { useEffect, useMemo } from 'react'
import { useStore } from 'zustand'
import { startComputerSessions, useComputerAsks, type ComputerAsk } from '../lib/computerSessions'
import { macBridgeStore } from '../lib/macBridge'
import { useToastSync } from './toastSync'

/**
 * A box thread's computer card waiting on its Mac (docs/box.md "Computer use
 * from a box thread"): one sonner toast per thread whose mirrored row says
 * `asking`, titled with the card's question and naming the Mac where it is
 * decided. No buttons: only the person at the Mac decides. None while this
 * window is that Mac and holds the card itself (MacBridgeCards draws it), and
 * gone once the row stops asking.
 */

const idOf = (ask: ComputerAsk): string => `computer-ask:${ask.environmentId}:${ask.row.threadId}`
const signatureOf = (ask: ComputerAsk): string => `${ask.row.asking.line}\0${ask.row.macName ?? ''}`

/** "Allow or deny it on Studio": where the decision is made. */
export const askDescription = (ask: ComputerAsk): string => `Allow or deny it on ${ask.row.macName ?? 'the Mac'}`

export function ComputerAskToasts() {
  useEffect(() => startComputerSessions(), [])
  const asks = useComputerAsks()
  const requests = useStore(macBridgeStore, (s) => s.requests)
  const shown = useMemo(() => {
    const own = new Set<string>()
    for (const r of Object.values(requests))
      if (r.kind === 'computer' && r.status === 'pending') own.add(`${r.environmentId}:${r.sessionId}`)
    return own.size ? asks.filter((a) => !own.has(`${a.environmentId}:${a.row.threadId}`)) : asks
  }, [asks, requests])
  useToastSync(
    shown,
    idOf,
    (toast, ask, id) => {
      toast(ask.row.asking.line, {
        id,
        duration: Infinity,
        description: <span data-computer-ask={ask.row.threadId}>{askDescription(ask)}</span>
      })
    },
    signatureOf
  )
  return null
}
