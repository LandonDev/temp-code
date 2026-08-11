import { create } from 'zustand'
import type { CATALOG } from '@shared/catalog'
import type { EventRow, SessionMeta } from '@shared/events'
import type { CreateSessionParams } from '@shared/contract'
import { client } from '../lib/client'

type Catalog = typeof CATALOG

interface AppState {
  connected: boolean
  catalog: Catalog | null
  sessions: Record<string, SessionMeta>
  events: Record<string, EventRow[]>
  selectedId: string | null

  init: () => Promise<void>
  select: (sessionId: string | null) => Promise<void>
  createSession: (params: CreateSessionParams) => Promise<SessionMeta>
  send: (sessionId: string, text: string) => Promise<void>
  interrupt: (sessionId: string) => Promise<void>
}

export const useApp = create<AppState>((set, get) => ({
  connected: false,
  catalog: null,
  sessions: {},
  events: {},
  selectedId: null,

  init: async () => {
    client.onPush((push) => {
      if (push.push === 'session') {
        set((s) => ({ sessions: { ...s.sessions, [push.session.id]: push.session } }))
      } else if (push.push === 'event') {
        const { sessionId } = push.row
        set((s) => ({
          events: { ...s.events, [sessionId]: [...(s.events[sessionId] ?? []), push.row] }
        }))
      }
    })
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
        return { events: { ...s.events, [sessionId]: merged } }
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
  }
}))
