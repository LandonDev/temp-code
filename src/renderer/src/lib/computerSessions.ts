import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { ComputerSessionRow, ComputerSessionsAnswer } from '@server/shared/contract-computer'
import { registry } from './connection/registry'
import type { EnvLink } from './connection/link'

/**
 * Each connected host's live computer sessions (docs/computer-protocol.md
 * "The host"; docs/box.md "Computer use from a box thread"): read once per
 * link-up with `computer.sessions`, then kept by the host's `computer` push.
 * A box thread bridged to a Mac has its row on the box's own push, re-keyed
 * to the thread, with the Mac's id and name (`macPeer`, `macName`) and, while
 * a card waits there, `asking`.
 */

interface ComputerSessionsState {
  byHost: Record<string, ComputerSessionRow[]>
}

const store = createStore<ComputerSessionsState>(() => ({ byHost: {} }))
export const computerSessionsStore = store

const EMPTY: ComputerSessionRow[] = []

function setRows(environmentId: string, rows: ComputerSessionRow[]): void {
  store.setState((s) => ({ byHost: { ...s.byHost, [environmentId]: rows } }))
}

async function load(link: EnvLink): Promise<void> {
  try {
    const answer = await link.request<ComputerSessionsAnswer>('computer.sessions', {})
    setRows(link.environmentId, answer.sessions)
  } catch {
    /* an older host without computer use */
  }
}

let started = false
/** Hear every host's `computer` push and read its sessions once per link-up; idempotent. */
export function startComputerSessions(): void {
  if (started) return
  started = true
  const attach = (link: EnvLink): void => {
    link.onPush((push) => {
      if (push.push === 'computer') setRows(link.environmentId, push.sessions)
    })
    link.onOpen(() => void load(link))
    if (link.connected) void load(link)
  }
  registry.onLink((link, event) => {
    if (event === 'added') attach(link)
    else store.setState((s) => {
      if (!(link.environmentId in s.byHost)) return s
      const next = { ...s.byHost }
      delete next[link.environmentId]
      return { byHost: next }
    })
  })
}

/** One thread's live row on its host, or null. */
export function useComputerRow(environmentId: string, threadId: string): ComputerSessionRow | null {
  return useStore(store, (s) => (s.byHost[environmentId] ?? EMPTY).find((r) => r.threadId === threadId) ?? null)
}

/** A row waiting on a card at its Mac, with the host that mirrors it. */
export interface ComputerAsk {
  environmentId: string
  row: ComputerSessionRow & { asking: { line: string } }
}

/** Every bridged row whose card waits on its Mac, in host then thread order; the same array while nothing asking changed. */
export function asksOf(byHost: Record<string, ComputerSessionRow[]>): ComputerAsk[] {
  const out: ComputerAsk[] = []
  for (const [environmentId, rows] of Object.entries(byHost))
    for (const row of rows) if (row.asking && row.macPeer) out.push({ environmentId, row: row as ComputerAsk['row'] })
  return out
}

let lastByHost: Record<string, ComputerSessionRow[]> | null = null
let lastAsks: ComputerAsk[] = []
const asksSelector = (s: ComputerSessionsState): ComputerAsk[] => {
  if (s.byHost === lastByHost) return lastAsks
  lastByHost = s.byHost
  const next = asksOf(s.byHost)
  const same = next.length === lastAsks.length && next.every((a, i) => a.row === lastAsks[i]?.row && a.environmentId === lastAsks[i]?.environmentId)
  if (!same) lastAsks = next
  return lastAsks
}

export function useComputerAsks(): ComputerAsk[] {
  return useStore(store, asksSelector)
}
