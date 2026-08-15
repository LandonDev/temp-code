import { create } from 'zustand'
import type { CATALOG, ProviderId, Reasoning } from '@shared/catalog'
import type { Attachment, EventRow, PermissionPolicy, SessionMeta } from '@shared/events'
import type {
  FileChange,
  ProjectMeta,
  ProjectMode,
  SlashCommand,
  ThreadType,
  WorkspaceMeta
} from '@shared/domain'
import type { CreateSessionInput } from '@shared/contract'
import { client } from '../lib/client'
import {
  foldAll,
  foldEvent,
  foldOptimisticUser,
  type Block,
  type FoldState,
  type TodoItem
} from './blocks'

type Catalog = typeof CATALOG

/** Per-provider CLI health (mirror of the server's DoctorReport). */
export interface ProviderHealth {
  found: boolean
  path?: string
  version?: string
  error?: string
}

export type ThemePref = 'system' | 'light' | 'dark'

const FAVORITES_KEY = 'model-favorites'
const THEME_KEY = 'theme'
const LAST_SEEN_KEY = 'thread-last-seen'

const osDark = window.matchMedia('(prefers-color-scheme: dark)')

/** Apply a theme preference to <html>; 'system' follows the OS. */
export function applyTheme(pref: ThemePref): void {
  const dark = pref === 'system' ? osDark.matches : pref === 'dark'
  document.documentElement.classList.toggle('dark', dark)
}

export function storedTheme(): ThemePref {
  const raw = localStorage.getItem(THEME_KEY)
  return raw === 'light' || raw === 'dark' ? raw : 'system'
}

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
  /** slash commands per `${provider}:${cwd}` (skills/commands/prompts) */
  commands: Record<string, SlashCommand[]>
  /** project working-tree paths, for @-mention autocomplete */
  files: Record<string, string[]>
  selectedProjectId: string | null
  /** the open thread (or unsorted legacy session) */
  selectedId: string | null
  /** sessions whose event backlog has arrived (Transcript loader gate) */
  loaded: Record<string, boolean>
  railOpen: boolean
  /** project-relative path the right rail's diff view is showing */
  railDiff: string | null
  settingsOpen: boolean
  theme: ThemePref
  doctor: Record<ProviderId, ProviderHealth> | null
  /** starred models, `${provider}:${modelId}` (persisted) */
  favoriteModels: string[]
  /** per-thread last-seen activity timestamp (persisted) — unread dots */
  lastSeen: Record<string, number>

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
  send: (
    sessionId: string,
    text: string,
    opts?: {
      provider?: ProviderId
      model?: string
      reasoning?: Reasoning
      attachments?: Attachment[]
    }
  ) => Promise<void>
  interrupt: (sessionId: string) => Promise<void>
  approve: (sessionId: string, requestId: string, allow: boolean) => Promise<void>
  /** Answer a model question; null = dismiss without answering. */
  answer: (sessionId: string, requestId: string, answers: string[][] | null) => Promise<void>
  setPermission: (sessionId: string, permission: PermissionPolicy) => Promise<void>
  setArchived: (sessionId: string, archived: boolean) => Promise<void>
  renameSession: (sessionId: string, title: string) => Promise<void>
  /** Mark a thread's activity as seen (clears its unread dot). */
  markSeen: (sessionId: string) => void
  deleteSession: (sessionId: string) => Promise<void>
  restartSession: (sessionId: string) => Promise<void>
  fetchChanges: (projectId: string) => Promise<void>
  fetchCommands: (provider: string, cwd: string) => Promise<void>
  fetchFiles: (projectId: string) => Promise<void>
  saveAttachment: (name: string, dataBase64: string) => Promise<Attachment>
  readFile: (path: string) => Promise<string | null>
  setRailOpen: (open: boolean) => void
  setRailDiff: (path: string | null) => void
  setSettingsOpen: (open: boolean) => void
  setTheme: (theme: ThemePref) => void
  fetchDoctor: () => Promise<void>
  toggleFavoriteModel: (provider: ProviderId, modelId: string) => void
  /** Open the right rail on a file's diff. Accepts absolute or
   *  project-relative paths; absolute paths outside the project no-op. */
  openFileRef: (path: string) => void
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
  commands: {},
  files: {},
  selectedProjectId: null,
  selectedId: null,
  loaded: {},
  railOpen: false,
  railDiff: null,
  settingsOpen: false,
  theme: storedTheme(),
  doctor: null,
  favoriteModels: JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? '[]') as string[],
  lastSeen: JSON.parse(localStorage.getItem(LAST_SEEN_KEY) ?? '{}') as Record<string, number>,

  init: async () => {
    if (initStarted) return
    initStarted = true
    client.onPush((push) => {
      if (push.push === 'session') {
        set((s) => ({ sessions: { ...s.sessions, [push.session.id]: push.session } }))
        if (push.session.id === get().selectedId) get().markSeen(push.session.id)
      } else if (push.push === 'event') {
        const { sessionId } = push.row
        // Ephemeral rows (streaming tool-input previews) fold into the live
        // view but never join the stored event list — the final event with
        // the same callId replaces them.
        if (push.row.ephemeral) {
          const fold = folds.get(sessionId)
          if (fold) {
            foldEvent(fold, push.row.event, push.row.ts)
            publishFold(set, sessionId, fold)
          }
          return
        }
        // Seq guard: a duplicate push (double subscription, refetch race)
        // must never be applied twice.
        if (push.row.seq <= (get().events[sessionId]?.at(-1)?.seq ?? 0)) return
        let fold = folds.get(sessionId)
        if (!fold) {
          fold = foldAll(get().events[sessionId] ?? [])
          folds.set(sessionId, fold)
        }
        foldEvent(fold, push.row.event, push.row.ts)
        set((s) => ({
          events: { ...s.events, [sessionId]: [...(s.events[sessionId] ?? []), push.row] }
        }))
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
    set((st) => {
      const lastSeen = { ...st.lastSeen }
      for (const sess of sessions) {
        if (lastSeen[sess.id] === undefined) lastSeen[sess.id] = sess.updatedAt
      }
      localStorage.setItem(LAST_SEEN_KEY, JSON.stringify(lastSeen))
      return {
        workspaces,
        projects,
        sessions: Object.fromEntries(sessions.map((s) => [s.id, s])),
        lastSeen
      }
    })
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
    // Sidebar navigation always leaves the settings page, even when the
    // target project is already selected.
    set({ settingsOpen: false })
    if (projectId === get().selectedProjectId) return
    set({ selectedProjectId: projectId, railDiff: null })
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
    set({ selectedId: sessionId, settingsOpen: false })
    if (!sessionId) return
    get().markSeen(sessionId)
    await get().loadSession(sessionId)
  },

  loadSession: async (sessionId) => {
    await client.request('session.subscribe', { sessionId })
    const lastSeq = get().events[sessionId]?.at(-1)?.seq ?? 0
    const rows = await client.request<EventRow[]>('session.events', {
      sessionId,
      afterSeq: lastSeq
    })
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
    set((s) => ({ loaded: { ...s.loaded, [sessionId]: true } }))
  },

  createThread: async (params) => {
    const session = await client.request<SessionMeta>('session.create', params)
    set((s) => ({ sessions: { ...s.sessions, [session.id]: session } }))
    await get().select(session.id)
    return session
  },

  send: async (sessionId, text, opts) => {
    // Optimistic: the message and the working state appear this frame; the
    // server's echo claims the block instead of duplicating it.
    let fold = folds.get(sessionId)
    if (!fold) {
      fold = foldAll(get().events[sessionId] ?? [])
      folds.set(sessionId, fold)
    }
    foldOptimisticUser(fold, text, opts?.attachments)
    publishFold(set, sessionId, fold)
    const before = get().sessions[sessionId]
    if (before && before.status !== 'running') {
      set((s) => ({
        sessions: { ...s.sessions, [sessionId]: { ...before, status: 'starting' } }
      }))
    }
    try {
      await client.request('session.send', { sessionId, text, ...opts })
    } catch (err) {
      // Roll back: refold from the authoritative log, restore status.
      const clean = foldAll(get().events[sessionId] ?? [])
      folds.set(sessionId, clean)
      publishFold(set, sessionId, clean)
      if (before) set((s) => ({ sessions: { ...s.sessions, [sessionId]: before } }))
      throw err
    }
  },

  interrupt: async (sessionId) => {
    await client.request('session.interrupt', { sessionId })
  },

  approve: async (sessionId, requestId, allow) => {
    await client.request('session.approve', { sessionId, requestId, allow })
  },

  answer: async (sessionId, requestId, answers) => {
    await client.request('session.answer', { sessionId, requestId, answers })
  },

  renameSession: async (sessionId, title) => {
    const t = title.trim()
    if (!t) return
    // Optimistic: the meta push echoes the authoritative row.
    set((s) => {
      const cur = s.sessions[sessionId]
      return cur ? { sessions: { ...s.sessions, [sessionId]: { ...cur, title: t } } } : {}
    })
    await client.request('session.rename', { sessionId, title: t })
  },

  markSeen: (sessionId) => {
    const stamp = Math.max(Date.now(), get().sessions[sessionId]?.updatedAt ?? 0)
    set((s) => {
      const lastSeen = { ...s.lastSeen, [sessionId]: stamp }
      localStorage.setItem(LAST_SEEN_KEY, JSON.stringify(lastSeen))
      return { lastSeen }
    })
  },

  setPermission: async (sessionId, permission) => {
    await client.request('session.permission', { sessionId, permission })
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
    const list = await client
      .request<FileChange[]>('project.changes', { projectId })
      .catch(() => [])
    set((s) => ({ changes: { ...s.changes, [projectId]: list } }))
  },

  fetchCommands: async (provider, cwd) => {
    const key = `${provider}:${cwd}`
    const list = await client
      .request<SlashCommand[]>('commands.list', { provider, cwd })
      .catch(() => [])
    set((s) => ({ commands: { ...s.commands, [key]: list } }))
  },

  fetchFiles: async (projectId) => {
    const list = await client.request<string[]>('project.files', { projectId }).catch(() => [])
    set((s) => ({ files: { ...s.files, [projectId]: list } }))
  },

  saveAttachment: async (name, dataBase64) => {
    return client.request<Attachment>('attachment.save', { name, dataBase64 })
  },

  readFile: async (path) => {
    return client.request<string | null>('file.read', { path }).catch(() => null)
  },

  setRailOpen: (open) => set({ railOpen: open, ...(open ? {} : { railDiff: null }) }),
  setRailDiff: (path) => set({ railDiff: path }),

  setSettingsOpen: (open) => set({ settingsOpen: open }),

  setTheme: (theme) => {
    localStorage.setItem(THEME_KEY, theme)
    applyTheme(theme)
    set({ theme })
  },

  fetchDoctor: async () => {
    const doctor = await client.request<Record<ProviderId, ProviderHealth>>('doctor.get')
    set({ doctor })
  },

  toggleFavoriteModel: (provider, modelId) => {
    const key = `${provider}:${modelId}`
    const next = get().favoriteModels.includes(key)
      ? get().favoriteModels.filter((k) => k !== key)
      : [...get().favoriteModels, key]
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(next))
    set({ favoriteModels: next })
  },

  openFileRef: (path) => {
    const { selectedProjectId, projects } = get()
    const project = projects.find((p) => p.id === selectedProjectId)
    if (!project) return
    let rel = path.replace(/:\d+(?::\d+)?$/, '') // strip :line(:col)
    if (rel.startsWith('/')) {
      const root = project.cwd.endsWith('/') ? project.cwd : `${project.cwd}/`
      if (!rel.startsWith(root)) return
      rel = rel.slice(root.length)
    }
    set({ railOpen: true, railDiff: rel })
  }
}))

/** Root threads of a project, newest last (strip order = creation order). */
export const threadsOfProject = (
  sessions: Record<string, SessionMeta>,
  projectId: string | null
): SessionMeta[] =>
  Object.values(sessions)
    .filter((s) => s.projectId === projectId && !s.parentId && !s.archived)
    .sort((a, b) => b.updatedAt - a.updatedAt)

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

// Dev-only: expose the store for CDP-driven inspection in `bun run dev`.
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__app = useApp
}
