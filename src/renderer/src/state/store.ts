import { create } from 'zustand'
import type { CATALOG } from '@shared/catalog'
import type { EventRow, SessionMeta } from '@shared/events'
import type { CreateSessionParams } from '@shared/contract'
import { client } from '../lib/client'
import { foldAll, foldEvent, type Block, type FoldState } from './blocks'

type Catalog = typeof CATALOG

/** Per-session fold state lives outside zustand; the store publishes
 *  immutable snapshots (blocks arrays) for React. */
const folds = new Map<string, FoldState>()

interface AppState {
  connected: boolean
  catalog: Catalog | null
  sessions: Record<string, SessionMeta>
  events: Record<string, EventRow[]>
  blocks: Record<string, Block[]>
  costs: Record<string, number | undefined>
  selectedId: string | null

  init: () => Promise<void>
  select: (sessionId: string | null) => Promise<void>
  createSession: (params: CreateSessionParams) => Promise<SessionMeta>
  send: (sessionId: string, text: string) => Promise<void>
  interrupt: (sessionId: string) => Promise<void>
  approve: (sessionId: string, requestId: string, allow: boolean) => Promise<void>
  setArchived: (sessionId: string, archived: boolean) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  restartSession: (sessionId: string) => Promise<void>
}

export const useApp = create<AppState>((set, get) => ({
  connected: false,
  catalog: null,
  sessions: {},
  events: {},
  blocks: {},
  costs: {},
  selectedId: null,

  init: async () => {
    client.onPush((push) => {
      if (push.push === 'session') {
        set((s) => ({ sessions: { ...s.sessions, [push.session.id]: push.session } }))
      } else if (push.push === 'event') {
        const { sessionId } = push.row
        let fold = folds.get(sessionId)
        if (!fold) {
          fold = foldAll(get().events[sessionId] ?? [])
          folds.set(sessionId, fold)
        }
        foldEvent(fold, push.row.event)
        set((s) => ({
          events: { ...s.events, [sessionId]: [...(s.events[sessionId] ?? []), push.row] },
          blocks: { ...s.blocks, [sessionId]: fold.blocks.slice() },
          costs: { ...s.costs, [sessionId]: fold.costUsd }
        }))
      } else if (push.push === 'session-removed') {
        set((s) => {
          const sessions = { ...s.sessions }
          const events = { ...s.events }
          const blocks = { ...s.blocks }
          const costs = { ...s.costs }
          for (const id of push.sessionIds) {
            delete sessions[id]
            delete events[id]
            delete blocks[id]
            delete costs[id]
            folds.delete(id)
          }
          const selectedId = push.sessionIds.includes(s.selectedId ?? '') ? null : s.selectedId
          return { sessions, events, blocks, costs, selectedId }
        })
      }
    })
    client.onClose(() => set({ connected: false }))
    client.onOpen(() => {
      // After (re)connect: refresh state and resubscribe the open session.
      void (async () => {
        const sessions = await client.request<SessionMeta[]>('session.list')
        set({
          connected: true,
          sessions: Object.fromEntries(sessions.map((s) => [s.id, s]))
        })
        const sel = get().selectedId
        if (sel) await get().select(sel)
      })()
    })
    await client.connect()
    const catalog = await client.request<Catalog>('catalog.get')
    set({ catalog })
  },

  select: async (sessionId) => {
    const prev = get().selectedId
    if (prev && prev !== sessionId) {
      void client.request('session.unsubscribe', { sessionId: prev }).catch(() => {})
    }
    set({ selectedId: sessionId })
    if (!sessionId) return
    await client.request('session.subscribe', { sessionId })
    const lastSeq = get().events[sessionId]?.at(-1)?.seq ?? 0
    const rows = await client.request<EventRow[]>('session.events', { sessionId, afterSeq: lastSeq })
    if (rows.length) {
      set((s) => {
        const seen = new Set((s.events[sessionId] ?? []).map((r) => r.seq))
        const merged = [...(s.events[sessionId] ?? []), ...rows.filter((r) => !seen.has(r.seq))]
        merged.sort((a, b) => a.seq - b.seq)
        // History arrived out of band — refold from scratch.
        const fold = foldAll(merged)
        folds.set(sessionId, fold)
        return {
          events: { ...s.events, [sessionId]: merged },
          blocks: { ...s.blocks, [sessionId]: fold.blocks.slice() },
          costs: { ...s.costs, [sessionId]: fold.costUsd }
        }
      })
    }
  },

  createSession: async (params) => {
    const session = await client.request<SessionMeta>('session.create', params)
    set((s) => ({ sessions: { ...s.sessions, [session.id]: session } }))
    await get().select(session.id)
    return session
  },

  send: async (sessionId, text) => {
    await client.request('session.send', { sessionId, text })
  },

  interrupt: async (sessionId) => {
    await client.request('session.interrupt', { sessionId })
  },

  approve: async (sessionId, requestId, allow) => {
    await client.request('session.approve', { sessionId, requestId, allow })
  },

  setArchived: async (sessionId, archived) => {
    await client.request('session.archive', { sessionId, archived })
  },

  deleteSession: async (sessionId) => {
    await client.request('session.delete', { sessionId })
  },

  restartSession: async (sessionId) => {
    await client.request('session.restart', { sessionId })
  }
}))
