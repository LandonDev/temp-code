import { create } from 'zustand'
import type { CATALOG } from '@shared/catalog'
import type { EventRow, SessionMeta } from '@shared/events'
import type { FileChange, ProjectMeta, ProjectMode, ThreadType, WorkspaceMeta } from '@shared/domain'
import type { CreateSessionInput } from '@shared/contract'
import { client } from '../lib/client'
import { foldAll, foldEvent, type Block, type FoldState, type TodoItem } from './blocks'

type Catalog = typeof CATALOG

/** Per-session fold state lives outside zustand; the store publishes
 *  immutable snapshots (blocks arrays) for React. */
const folds = new Map<string, FoldState>()

/** StrictMode mounts effects twice in dev — init must run once. */
let initStarted = false

interface AppState {
  connected: boolean
  catalog: Catalog | null
  workspaces: WorkspaceMeta[]
  projects: ProjectMeta[]
  sessions: Record<string, SessionMeta>
  events: Record<string, EventRow[]>
  blocks: Record<string, Block[]>
  costs: Record<string, number | undefined>
  todos: Record<string, TodoItem[]>
  changes: Record<string, FileChange[]>
  selectedProjectId: string | null
  /** the open thread (or unsorted legacy session) */
  selectedId: string | null
  railOpen: boolean

  init: () => Promise<void>
  refreshTree: () => Promise<void>
  addWorkspace: (path: string) => Promise<WorkspaceMeta>
  removeWorkspace: (workspaceId: string) => Promise<void>
  createProject: (workspaceId: string, name: string, mode: ProjectMode) => Promise<ProjectMeta>
  removeProject: (projectId: string) => Promise<void>
  selectProject: (projectId: string | null) => void
  select: (sessionId: string | null) => Promise<void>
  /** subscribe + backfill a session WITHOUT selecting it (agent drill-in) */
  loadSession: (sessionId: string) => Promise<void>
  createThread: (params: CreateSessionInput & { threadType: ThreadType }) => Promise<SessionMeta>
  send: (sessionId: string, text: string) => Promise<void>
  interrupt: (sessionId: string) => Promise<void>
  approve: (sessionId: string, requestId: string, allow: boolean) => Promise<void>
  setArchived: (sessionId: string, archived: boolean) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  restartSession: (sessionId: string) => Promise<void>
  fetchChanges: (projectId: string) => Promise<void>
  readFile: (path: string) => Promise<string | null>
  setRailOpen: (open: boolean) => void
}

function publishFold(
  set: (fn: (s: AppState) => Partial<AppState>) => void,
  sessionId: string,
  fold: FoldState
): void {
  set((s) => ({
    blocks: { ...s.blocks, [sessionId]: fold.blocks.slice() },
    costs: { ...s.costs, [sessionId]: fold.costUsd },
    todos: { ...s.todos, [sessionId]: fold.todos }
  }))
}

export const useApp = create<AppState>((set, get) => ({
  connected: false,
  catalog: null,
  workspaces: [],
  projects: [],
  sessions: {},
  events: {},
  blocks: {},
  costs: {},
  todos: {},
  changes: {},
  selectedProjectId: null,
  selectedId: null,
  railOpen: false,

  init: async () => {
    if (initStarted) return
    initStarted = true
    client.onPush((push) => {
      if (push.push === 'session') {
        set((s) => ({ sessions: { ...s.sessions, [push.session.id]: push.session } }))
      } else if (push.push === 'event') {
        const { sessionId } = push.row
        // Seq guard: a duplicate push (double subscription, refetch race)
        // must never be applied twice.
        if (push.row.seq <= (get().events[sessionId]?.at(-1)?.seq ?? 0)) return
        let fold = folds.get(sessionId)
        if (!fold) {
          fold = foldAll(get().events[sessionId] ?? [])
          folds.set(sessionId, fold)
        }
        foldEvent(fold, push.row.event)
        set((s) => ({ events: { ...s.events, [sessionId]: [...(s.events[sessionId] ?? []), push.row] } }))
        publishFold(set, sessionId, fold)
      } else if (push.push === 'session-removed') {
        set((s) => {
          const sessions = { ...s.sessions }
          const events = { ...s.events }
          const blocks = { ...s.blocks }
          const costs = { ...s.costs }
          const todos = { ...s.todos }
          for (const id of push.sessionIds) {
            delete sessions[id]
            delete events[id]
            delete blocks[id]
            delete costs[id]
            delete todos[id]
            folds.delete(id)
          }
          const selectedId = push.sessionIds.includes(s.selectedId ?? '') ? null : s.selectedId
          return { sessions, events, blocks, costs, todos, selectedId }
        })
      }
    })
    client.onClose(() => set({ connected: false }))
    client.onOpen(() => {
      // After (re)connect: refresh state and resubscribe the open session.
      void (async () => {
        await get().refreshTree()
        set({ connected: true })
        const sel = get().selectedId
        if (sel) await get().select(sel)
      })()
    })
    await client.connect()
    const catalog = await client.request<Catalog>('catalog.get')
    set({ catalog })
    // Land somewhere sensible: the first project, if any.
    const { projects, selectedProjectId } = get()
    if (!selectedProjectId && projects.length) get().selectProject(projects[0].id)
  },

  refreshTree: async () => {
    const [workspaces, projects, sessions] = await Promise.all([
      client.request<WorkspaceMeta[]>('workspace.list'),
      client.request<ProjectMeta[]>('project.list'),
      client.request<SessionMeta[]>('session.list')
    ])
    set({ workspaces, projects, sessions: Object.fromEntries(sessions.map((s) => [s.id, s])) })
  },

  addWorkspace: async (path) => {
    const ws = await client.request<WorkspaceMeta>('workspace.create', { path })
    await get().refreshTree()
    return ws
  },

  removeWorkspace: async (workspaceId) => {
    await client.request('workspace.delete', { workspaceId })
    const { selectedProjectId, projects } = get()
    if (projects.find((p) => p.id === selectedProjectId)?.workspaceId === workspaceId) {
      set({ selectedProjectId: null, selectedId: null })
    }
    await get().refreshTree()
  },

  createProject: async (workspaceId, name, mode) => {
    const project = await client.request<ProjectMeta>('project.create', { workspaceId, name, mode })
    await get().refreshTree()
    return project
  },

  removeProject: async (projectId) => {
    await client.request('project.delete', { projectId })
    if (get().selectedProjectId === projectId) set({ selectedProjectId: null, selectedId: null })
    await get().refreshTree()
  },

  selectProject: (projectId) => {
    if (projectId === get().selectedProjectId) return
    set({ selectedProjectId: projectId })
    // Open the project's most recent thread, if it has one.
    const threads = Object.values(get().sessions)
      .filter((s) => s.projectId === projectId && !s.parentId && !s.archived)
      .sort((a, b) => b.createdAt - a.createdAt)
    void get().select(threads[0]?.id ?? null)
    if (projectId) void get().fetchChanges(projectId)
  },

  select: async (sessionId) => {
    const prev = get().selectedId
    if (prev && prev !== sessionId) {
      void client.request('session.unsubscribe', { sessionId: prev }).catch(() => {})
    }
    set({ selectedId: sessionId })
    if (!sessionId) return
    await get().loadSession(sessionId)
  },

  loadSession: async (sessionId) => {
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
      // History arrived out of band — refold from scratch.
      const fold = foldAll(get().events[sessionId] ?? [])
      folds.set(sessionId, fold)
      publishFold(set, sessionId, fold)
    }
  },

  createThread: async (params) => {
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
  },

  fetchChanges: async (projectId) => {
    const list = await client.request<FileChange[]>('project.changes', { projectId }).catch(() => [])
    set((s) => ({ changes: { ...s.changes, [projectId]: list } }))
  },

  readFile: async (path) => {
    return client.request<string | null>('file.read', { path }).catch(() => null)
  },

  setRailOpen: (open) => set({ railOpen: open })
}))

/** Root threads of a project, newest last (strip order = creation order). */
export const threadsOfProject = (
  sessions: Record<string, SessionMeta>,
  projectId: string | null
): SessionMeta[] =>
  Object.values(sessions)
    .filter((s) => s.projectId === projectId && !s.parentId && !s.archived)
    .sort((a, b) => a.createdAt - b.createdAt)

/** Legacy/loose root sessions with no project. */
export const unsortedSessions = (sessions: Record<string, SessionMeta>): SessionMeta[] =>
  Object.values(sessions)
    .filter((s) => !s.projectId && !s.parentId && !s.archived)
    .sort((a, b) => b.createdAt - a.createdAt)

/** Subagents of an orchestration thread, oldest first. */
export const childrenOf = (
  sessions: Record<string, SessionMeta>,
  parentId: string
): SessionMeta[] =>
  Object.values(sessions)
    .filter((s) => s.parentId === parentId)
    .sort((a, b) => a.createdAt - b.createdAt)
