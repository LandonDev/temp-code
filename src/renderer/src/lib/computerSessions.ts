import { useEffect, useMemo } from 'react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { ComputerServiceState, ComputerSessionRow, ComputerSessionsAnswer } from '@server/shared/contract-computer'
import { macComputerKey } from '@server/shared/contract-maccomputer'
import { LOCAL_ENVIRONMENT_ID, registry } from './connection/registry'
import type { EnvLink } from './connection/link'
import { nativePlatform } from './native'
import { isWebMode } from './nativeWeb'

/**
 * Each connected host's live computer sessions (docs/computer-protocol.md
 * "The host"; docs/box.md "Computer use from a box thread"): read once per
 * link-up with `computer.sessions`, then kept by the host's `computer` push.
 * A box thread bridged to a Mac has its row on the box's own push, re-keyed
 * to the thread, with the Mac's id and name (`macPeer`, `macName`) and, while
 * a card waits there, `asking`. The Activity section reads a thread's tree's
 * rows as entries (`useComputerEntries`): only this Mac's desktop can preview
 * a session, and only one its own service runs. The same push carries the
 * host's service state, kept beside the rows for Settings → Computer use
 * (`useComputerService`).
 */

interface ComputerSessionsState {
  byHost: Record<string, ComputerSessionRow[]>
  serviceByHost: Record<string, ComputerServiceState>
}

const store = createStore<ComputerSessionsState>(() => ({ byHost: {}, serviceByHost: {} }))
export const computerSessionsStore = store

const EMPTY: ComputerSessionRow[] = []

function setRows(environmentId: string, rows: ComputerSessionRow[], service: ComputerServiceState): void {
  store.setState((s) => ({ byHost: { ...s.byHost, [environmentId]: rows }, serviceByHost: { ...s.serviceByHost, [environmentId]: service } }))
}

/** A state this page made and the host answered (Try again), ahead of the push that follows it. */
export function setComputerService(environmentId: string, service: ComputerServiceState): void {
  store.setState((s) => ({ serviceByHost: { ...s.serviceByHost, [environmentId]: service } }))
}

async function load(link: EnvLink): Promise<void> {
  try {
    const answer = await link.request<ComputerSessionsAnswer>('computer.sessions', {})
    setRows(link.environmentId, answer.sessions, answer.service)
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
      if (push.push === 'computer') setRows(link.environmentId, push.sessions, push.service)
    })
    link.onOpen(() => void load(link))
    if (link.connected) void load(link)
  }
  registry.onLink((link, event) => {
    if (event === 'added') attach(link)
    else store.setState((s) => {
      if (!(link.environmentId in s.byHost) && !(link.environmentId in s.serviceByHost)) return s
      const byHost = { ...s.byHost }
      const serviceByHost = { ...s.serviceByHost }
      delete byHost[link.environmentId]
      delete serviceByHost[link.environmentId]
      return { byHost, serviceByHost }
    })
  })
}

/** A host's computer service as its last `computer` push or read said, or null before either. */
export function useComputerService(environmentId: string): ComputerServiceState | null {
  useEffect(startComputerSessions, [])
  return useStore(store, (s) => s.serviceByHost[environmentId] ?? null)
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

export interface ComputerEntry {
  /** the host whose row this is: the thread's own */
  host: string
  row: ComputerSessionRow
  /** this desktop can draw the session's window */
  previewable: boolean
  /** the link the preview asks (this Mac's) and the key its service knows the session by */
  previewHost?: string
  previewKey?: string
}

export interface PreviewContext {
  /** the desktop app (not the browser /ui) on a Mac */
  macDesktop: boolean
  /** this Mac's real environment id, once its hello said it */
  localId: string | null
}

function previewContext(): PreviewContext {
  return {
    macDesktop: !isWebMode() && nativePlatform() === 'darwin',
    localId: registry.statusOf(LOCAL_ENVIRONMENT_ID).lastHello?.environmentId ?? null
  }
}

/** The entries of a thread's tree on its host, one per session, with what this desktop can preview. */
export function entriesOf(rows: readonly ComputerSessionRow[], tree: ReadonlySet<string>, threadHost: string, ctx: PreviewContext): ComputerEntry[] {
  return rows.flatMap((row) => {
    if (!tree.has(row.threadId)) return []
    const entry: ComputerEntry = { host: threadHost, row, previewable: false }
    if (!ctx.macDesktop) return [entry]
    if (threadHost === LOCAL_ENVIRONMENT_ID && !row.macPeer) {
      return [{ ...entry, previewable: true, previewHost: LOCAL_ENVIRONMENT_ID, previewKey: row.threadId }]
    }
    // A box thread driving this Mac: its session lives in this Mac's service, under the bridge's key.
    if (row.macPeer && ctx.localId && row.macPeer === ctx.localId && threadHost !== LOCAL_ENVIRONMENT_ID) {
      return [{ ...entry, previewable: true, previewHost: LOCAL_ENVIRONMENT_ID, previewKey: macComputerKey(threadHost, row.threadId) }]
    }
    return [entry]
  })
}

/** The computer entries of a thread's tree on the thread's host, live. */
export function useComputerEntries(tree: ReadonlySet<string>, threadHost: string | undefined): ComputerEntry[] {
  useEffect(startComputerSessions, [])
  const rows = useStore(store, (s) => (threadHost ? (s.byHost[threadHost] ?? EMPTY) : EMPTY))
  return useMemo(() => (threadHost && rows.length ? entriesOf(rows, tree, threadHost, previewContext()) : []), [rows, tree, threadHost])
}

/** Stop on the row: computer use ends for the thread's turn, on the thread's own host. */
export async function stopComputer(entry: ComputerEntry): Promise<void> {
  const link = registry.link(entry.host)
  if (!link) throw new Error('the host is not connected')
  await link.request('computer.stop', { sessionId: entry.row.threadId })
}
