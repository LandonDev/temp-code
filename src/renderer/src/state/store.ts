import { create } from 'zustand'
import type { CATALOG, ProviderId, Reasoning } from '@shared/catalog'
import type { Attachment, EventRow, PermissionPolicy, SessionMeta } from '@shared/events'
import type {
  BranchList,
  CommitInfo,
  FileChange,
  ProjectMeta,
  ProjectMode,
  SlashCommand,
  ThreadType,
  WorkspaceMeta
} from '@shared/domain'
import type { CreateSessionInput, QueuedMessage } from '@shared/contract'
import { client } from '../lib/client'
import { dispatchFileEvent, flushAllBuffers } from '../lib/file-events'
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

/** The doctor's Java row (docs/PLAN-3.md M13): JDK + jdtls download. */
export interface JavaHealth extends ProviderHealth {
  jdtls: boolean
  /** IntelliJ engine (docs/PLAN-4.md): dist + EULA state */
  ideaServer?: { dist: boolean; accepted: boolean; build: string }
}

export type DoctorReport = Record<ProviderId, ProviderHealth> & { java?: JavaHealth }

export type ThemePref = 'system' | 'light' | 'dark'

/** A non-thread tab in the surface strip (docs/PLAN-3.md M11/M14). */
export interface SurfaceRef {
  kind: 'file' | 'diff'
  /** project-relative path */
  path: string
}

export const surfaceKey = (s: SurfaceRef): string => `${s.kind}:${s.path}`

/** Debugger mirror (docs/PLAN-4.md M20) — written by editor/debug.ts. */
export interface DebugFrame {
  id: number
  name: string
  line: number
  /** project-relative, null when the frame is outside the project */
  path: string | null
}
export interface DebugVariable {
  name: string
  value: string
  /** expandable when set (variablesReference) */
  ref: number | null
  depth: number
  frameId: number
}

/** One row in the hierarchy overlay (caller or super/subtype). */
export interface HierarchyRow {
  name: string
  containerName: string
  uri: string
  range: { startLineNumber: number; startColumn: number }
}

const FAVORITES_KEY = 'model-favorites'
const THEME_KEY = 'theme'
const LAST_SEEN_KEY = 'thread-last-seen'
const MID_TURN_KEY = 'mid-turn-default'
const TOOL_SUMMARIES_KEY = 'tool-summaries'
const SURFACES_KEY = 'surfaces-v1'
const FORMAT_KEY = 'format-on-save'
const GHOST_KEY = 'ghost-text'

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

/** After a compaction boundary, the provider keeps reporting the
 *  pre-compact total until the next real turn. Fetches that still look
 *  pre-compact are dropped in favor of the boundary's numbers. */
const pendingCompact = new Map<string, { pre: number; post: number }>()

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
  /** which rail panel is up: Changes or Files */
  railPanel: 'changes' | 'files' | 'debug'
  /** open editor surfaces per project (persisted with the project) */
  surfaces: Record<string, SurfaceRef[]>
  /** active surface key per project; null = a thread is in the main view */
  activeSurface: Record<string, string | null>
  /** one-shot cursor reveal for the next surface mount, `${projectId}:${path}` */
  reveal: { key: string; position: { lineNumber: number; column: number } } | null
  /** autosave/conflict state per `${projectId}:${path}` (models.ts writes) */
  fileStates: Record<string, { pending: boolean; conflict: 'external' | 'deleted' | null }>
  /** error-marker counts per `${projectId}:${path}` (models.ts writes) */
  problems: Record<string, number>
  /** language-server busy line per project (import/index progress; null = idle) */
  lspBusy: Record<string, string | null>
  /** commit history + unpushed count per project (Changes rail) */
  gitLog: Record<string, { commits: CommitInfo[]; ahead: number | null }>
  /** branches of the workspace repo (project-create pickers) */
  branchLists: Record<string, BranchList>
  quickOpen: 'files' | 'symbols' | 'hierarchy' | null
  /** rows for the hierarchy overlay (⌃H / ⌃⌥H, docs/PLAN-4.md M18) */
  hierarchy: { title: string; rows: HierarchyRow[] } | null
  /** debugger (docs/PLAN-4.md M20) */
  debugPhase: 'idle' | 'launching' | 'running' | 'stopped'
  debugOutput: string[]
  debugFrames: DebugFrame[]
  debugVariables: DebugVariable[]
  debugCurrent: { path: string; line: number } | null
  debugError: string | null
  /** `${projectId}:${path}` → sorted breakpoint lines (mirror of debug.ts) */
  debugBreakpoints: Record<string, number[]>
  formatOnSave: { java: boolean; web: boolean }
  ghostText: boolean
  settingsOpen: boolean
  /** one-shot page to land on when settings opens (e.g. `ws:<id>`) */
  settingsJump: string | null
  theme: ThemePref
  doctor: DoctorReport | null
  /** starred models, `${provider}:${modelId}` (persisted) */
  favoriteModels: string[]
  /** per-thread last-seen activity timestamp (persisted) — unread dots */
  lastSeen: Record<string, number>
  /** messages waiting per session (server-owned; mirrored via push) */
  queues: Record<string, QueuedMessage[]>
  /** latest context-usage snapshot per session (claude /context data) */
  contexts: Record<string, unknown>
  /** what Enter does while a turn runs; ⌘Enter does the other */
  midTurnDefault: 'queue' | 'steer'
  /** settled tool sections get a one-sentence model-written summary */
  toolSummaries: boolean

  init: () => Promise<void>
  refreshTree: () => Promise<void>
  addWorkspace: (path: string) => Promise<WorkspaceMeta>
  removeWorkspace: (workspaceId: string) => Promise<void>
  createProject: (
    workspaceId: string,
    name: string,
    mode: ProjectMode,
    opts?: { baseRef?: string; existingBranch?: string }
  ) => Promise<ProjectMeta>
  removeProject: (projectId: string) => Promise<void>
  selectProject: (projectId: string | null) => void
  /** open (or focus) a file surface; reveal jumps the cursor after mount */
  openFileSurface: (
    projectId: string,
    path: string,
    revealAt?: { lineNumber: number; column: number } | null
  ) => void
  openDiffSurface: (projectId: string, path: string) => void
  closeSurface: (projectId: string, key: string) => void
  /** key of a file/diff surface, or null to show the selected thread */
  setActiveSurface: (projectId: string, key: string | null) => void
  clearReveal: () => void
  commitProject: (projectId: string, message: string, paths?: string[]) => Promise<void>
  pushProject: (projectId: string, targetBranch?: string) => Promise<void>
  fetchGitLog: (projectId: string) => Promise<void>
  fetchBranches: (workspaceId: string) => Promise<BranchList>
  setQuickOpen: (mode: 'files' | 'symbols' | 'hierarchy' | null) => void
  openHierarchy: (title: string, rows: HierarchyRow[]) => void
  setRailPanel: (panel: 'changes' | 'files' | 'debug') => void
  setFormatOnSave: (lang: 'java' | 'web', on: boolean) => void
  setGhostText: (on: boolean) => void
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
  setMidTurnDefault: (v: 'queue' | 'steer') => void
  setToolSummaries: (v: boolean) => void
  /** Fast mode / 1M context; harness restarts with resume on next send. */
  tune: (sessionId: string, patch: { fast?: boolean; context1m?: boolean }) => Promise<void>
  fetchContext: (sessionId: string) => Promise<void>
  queueAdd: (
    sessionId: string,
    text: string,
    opts?: {
      provider?: ProviderId
      model?: string
      reasoning?: Reasoning
      attachments?: Attachment[]
    }
  ) => Promise<void>
  queueRemove: (sessionId: string, messageId: string) => Promise<void>
  queueUpdate: (sessionId: string, messageId: string, text: string) => Promise<void>
  queueReorder: (sessionId: string, order: string[]) => Promise<void>
  queueSteer: (sessionId: string, messageId: string) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  restartSession: (sessionId: string) => Promise<void>
  fetchChanges: (projectId: string) => Promise<void>
  fetchCommands: (provider: string, cwd: string) => Promise<void>
  fetchFiles: (projectId: string) => Promise<void>
  saveAttachment: (name: string, dataBase64: string) => Promise<Attachment>
  readFile: (path: string) => Promise<string | null>
  setRailOpen: (open: boolean) => void
  setSettingsOpen: (open: boolean, jump?: string) => void
  clearSettingsJump: () => void
  renameProject: (projectId: string, name: string) => Promise<void>
  setTheme: (theme: ThemePref) => void
  fetchDoctor: () => Promise<void>
  toggleFavoriteModel: (provider: ProviderId, modelId: string) => void
  /** Open the right rail on a file's diff. Accepts absolute or
   *  project-relative paths; absolute paths outside the project no-op. */
  openFileRef: (path: string) => void
}

/** One project watched at a time: the selected one, while it has open
 *  surfaces or a visible rail (docs/PLAN-3.md M11 — watchers stop when
 *  nobody is looking). */
let watchedProjectId: string | null = null
function syncWatch(s: {
  selectedProjectId: string | null
  surfaces: Record<string, SurfaceRef[]>
  railOpen: boolean
}): void {
  const want =
    s.selectedProjectId && (s.railOpen || (s.surfaces[s.selectedProjectId] ?? []).length > 0)
      ? s.selectedProjectId
      : null
  if (want === watchedProjectId) return
  if (watchedProjectId) {
    void client
      .request('fs.watch', { projectId: watchedProjectId, subscribe: false })
      .catch(() => {})
  }
  watchedProjectId = want
  if (want) void client.request('fs.watch', { projectId: want, subscribe: true }).catch(() => {})
}

/** Debounced Changes-rail refresh off file events (push-driven, M12). */
const changeTimers = new Map<string, number>()
function scheduleChangesRefresh(
  projectId: string,
  fetchChanges: (id: string) => Promise<void>
): void {
  const prior = changeTimers.get(projectId)
  if (prior !== undefined) window.clearTimeout(prior)
  changeTimers.set(
    projectId,
    window.setTimeout(() => {
      changeTimers.delete(projectId)
      void fetchChanges(projectId)
    }, 300)
  )
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
  railPanel: 'changes',
  surfaces: JSON.parse(localStorage.getItem(SURFACES_KEY) ?? '{}') as Record<string, SurfaceRef[]>,
  activeSurface: {},
  reveal: null,
  fileStates: {},
  problems: {},
  lspBusy: {},
  gitLog: {},
  branchLists: {},
  quickOpen: null,
  hierarchy: null,
  debugPhase: 'idle',
  debugOutput: [],
  debugFrames: [],
  debugVariables: [],
  debugCurrent: null,
  debugError: null,
  debugBreakpoints: {},
  formatOnSave: JSON.parse(localStorage.getItem(FORMAT_KEY) ?? '{"java":false,"web":false}') as {
    java: boolean
    web: boolean
  },
  ghostText: localStorage.getItem(GHOST_KEY) === 'true',
  settingsOpen: false,
  settingsJump: null,
  theme: storedTheme(),
  doctor: null,
  favoriteModels: JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? '[]') as string[],
  lastSeen: JSON.parse(localStorage.getItem(LAST_SEEN_KEY) ?? '{}') as Record<string, number>,
  queues: {},
  contexts: {},
  midTurnDefault: localStorage.getItem(MID_TURN_KEY) === 'steer' ? 'steer' : 'queue',
  toolSummaries: localStorage.getItem(TOOL_SUMMARIES_KEY) !== 'off',

  init: async () => {
    if (initStarted) return
    initStarted = true
    client.onPush((push) => {
      if (push.push === 'session') {
        const prev = get().sessions[push.session.id]
        set((s) => ({ sessions: { ...s.sessions, [push.session.id]: push.session } }))
        if (push.session.id === get().selectedId) {
          get().markSeen(push.session.id)
        }
        // A provider switch hands the transcript to a fresh engine — the old
        // accounting means nothing there, so the meter empties until the
        // first reply. Model swaps within a provider keep the window.
        if (prev && prev.provider !== push.session.provider) {
          set((s) => {
            const rest = { ...s.contexts }
            delete rest[push.session.id]
            return { contexts: rest }
          })
        }
        // A settled turn is when the context accounting moved — capture it
        // even for unselected threads so the meter is never empty on switch.
        if (push.session.status === 'idle' && prev?.status !== 'idle') {
          void get().fetchContext(push.session.id)
        }
      } else if (push.push === 'queue') {
        set((s) => ({ queues: { ...s.queues, [push.sessionId]: push.items } }))
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
        // The provider's own usage report stays stale until the next turn,
        // so a finished compaction patches the snapshot from its boundary.
        const ev = push.row.event
        if (ev.type === 'compaction' && ev.phase === 'done' && ev.postTokens !== undefined) {
          const post = ev.postTokens
          if (ev.preTokens !== undefined) pendingCompact.set(sessionId, { pre: ev.preTokens, post })
          set((s) => {
            const c = s.contexts[sessionId] as
              | {
                  categories: { name: string; tokens: number }[]
                  totalTokens: number
                  maxTokens: number
                  percentage: number
                }
              | undefined
            if (!c) return {}
            const isMessages = (n: string): boolean => /message|conversation/i.test(n)
            const others = c.categories
              .filter((cat) => !isMessages(cat.name))
              .reduce((a, cat) => a + cat.tokens, 0)
            return {
              contexts: {
                ...s.contexts,
                [sessionId]: {
                  ...c,
                  totalTokens: post,
                  percentage: c.maxTokens > 0 ? (post / c.maxTokens) * 100 : 0,
                  categories: c.categories.map((cat) =>
                    isMessages(cat.name) ? { ...cat, tokens: Math.max(0, post - others) } : cat
                  )
                }
              }
            }
          })
        }
      } else if (push.push === 'file-event') {
        dispatchFileEvent(push)
        scheduleChangesRefresh(push.projectId, get().fetchChanges)
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
      // After (re)connect: refresh state and resubscribe the open session
      // and the file watcher (the server side died with the socket).
      void (async () => {
        await get().refreshTree()
        set({ connected: true })
        const sel = get().selectedId
        if (sel) await get().select(sel)
        watchedProjectId = null
        syncWatch(get())
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

  createProject: async (workspaceId, name, mode, opts) => {
    const project = await client.request<ProjectMeta>('project.create', {
      workspaceId,
      name,
      mode,
      ...opts
    })
    await get().refreshTree()
    return project
  },

  renameProject: async (projectId, name) => {
    await client.request('project.rename', { projectId, name })
    await get().refreshTree()
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
    void flushAllBuffers() // never leave a dirty buffer behind a switch
    set({ selectedProjectId: projectId })
    // Open the project's most recent thread, if it has one. Surfaces and
    // their active tab are per-project state — they restore by themselves.
    const threads = Object.values(get().sessions)
      .filter((s) => s.projectId === projectId && !s.parentId && !s.archived)
      .sort((a, b) => b.createdAt - a.createdAt)
    void get().select(threads[0]?.id ?? null)
    if (projectId) void get().fetchChanges(projectId)
    syncWatch(get())
  },

  openFileSurface: (projectId, path, revealAt) => {
    void flushAllBuffers()
    const key = `file:${path}`
    set((s) => {
      const list = s.surfaces[projectId] ?? []
      const surfaces = list.some((x) => surfaceKey(x) === key)
        ? s.surfaces
        : { ...s.surfaces, [projectId]: [...list, { kind: 'file' as const, path }] }
      localStorage.setItem(SURFACES_KEY, JSON.stringify(surfaces))
      return {
        surfaces,
        activeSurface: { ...s.activeSurface, [projectId]: key },
        reveal: revealAt ? { key: `${projectId}:${path}`, position: revealAt } : s.reveal
      }
    })
    syncWatch(get())
  },

  openDiffSurface: (projectId, path) => {
    void flushAllBuffers()
    const key = `diff:${path}`
    set((s) => {
      const list = s.surfaces[projectId] ?? []
      const surfaces = list.some((x) => surfaceKey(x) === key)
        ? s.surfaces
        : { ...s.surfaces, [projectId]: [...list, { kind: 'diff' as const, path }] }
      localStorage.setItem(SURFACES_KEY, JSON.stringify(surfaces))
      return { surfaces, activeSurface: { ...s.activeSurface, [projectId]: key } }
    })
    syncWatch(get())
  },

  closeSurface: (projectId, key) => {
    set((s) => {
      const list = s.surfaces[projectId] ?? []
      const at = list.findIndex((x) => surfaceKey(x) === key)
      const next = list.filter((x) => surfaceKey(x) !== key)
      const surfaces = { ...s.surfaces, [projectId]: next }
      localStorage.setItem(SURFACES_KEY, JSON.stringify(surfaces))
      // Closing the active tab hands focus to its neighbour, then threads.
      let active = s.activeSurface[projectId] ?? null
      if (active === key) {
        const neighbour = next[Math.min(Math.max(at, 0), next.length - 1)]
        active = neighbour ? surfaceKey(neighbour) : null
      }
      return { surfaces, activeSurface: { ...s.activeSurface, [projectId]: active } }
    })
    syncWatch(get())
  },

  setActiveSurface: (projectId, key) => {
    void flushAllBuffers()
    set((s) => ({ activeSurface: { ...s.activeSurface, [projectId]: key } }))
  },

  clearReveal: () => set({ reveal: null }),

  commitProject: async (projectId, message, paths) => {
    await client.request('project.commit', { projectId, message, paths })
    await Promise.all([get().fetchChanges(projectId), get().fetchGitLog(projectId)])
  },

  pushProject: async (projectId, targetBranch) => {
    await client.request('project.push', { projectId, targetBranch })
    await get().fetchGitLog(projectId)
  },

  fetchGitLog: async (projectId) => {
    const result = await client
      .request<{ commits: CommitInfo[]; ahead: number | null }>('project.log', {
        projectId,
        limit: 20
      })
      .catch(() => ({ commits: [], ahead: null }))
    set((s) => ({ gitLog: { ...s.gitLog, [projectId]: result } }))
  },

  fetchBranches: async (workspaceId) => {
    const list = await client.request<BranchList>('project.branches', { workspaceId })
    set((s) => ({ branchLists: { ...s.branchLists, [workspaceId]: list } }))
    return list
  },

  setQuickOpen: (mode) => set({ quickOpen: mode, ...(mode === null ? { hierarchy: null } : {}) }),
  openHierarchy: (title, rows) => set({ hierarchy: { title, rows }, quickOpen: 'hierarchy' }),

  setRailPanel: (panel) => set({ railPanel: panel }),

  setFormatOnSave: (lang, on) => {
    const formatOnSave = { ...get().formatOnSave, [lang]: on }
    localStorage.setItem(FORMAT_KEY, JSON.stringify(formatOnSave))
    set({ formatOnSave })
  },

  setGhostText: (on) => {
    localStorage.setItem(GHOST_KEY, String(on))
    set({ ghostText: on })
  },

  select: async (sessionId) => {
    const prev = get().selectedId
    if (prev && prev !== sessionId) {
      void client.request('session.unsubscribe', { sessionId: prev }).catch(() => {})
    }
    // Note: selecting a thread does NOT clear the active surface — the
    // strip does that on explicit tab clicks, so project switches restore
    // whichever surface was up when the user left.
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

  setMidTurnDefault: (v) => {
    localStorage.setItem(MID_TURN_KEY, v)
    set({ midTurnDefault: v })
  },

  setToolSummaries: (v) => {
    localStorage.setItem(TOOL_SUMMARIES_KEY, v ? 'on' : 'off')
    set({ toolSummaries: v })
  },

  queueAdd: async (sessionId, text, opts) => {
    await client.request('queue.add', { sessionId, text, ...opts })
  },
  queueRemove: async (sessionId, messageId) => {
    await client.request('queue.remove', { sessionId, messageId })
  },
  queueUpdate: async (sessionId, messageId, text) => {
    await client.request('queue.update', { sessionId, messageId, text })
  },
  queueReorder: async (sessionId, order) => {
    // Optimistic: drag must not fight the server round-trip.
    set((s) => {
      const cur = s.queues[sessionId] ?? []
      const byId = new Map(cur.map((m) => [m.id, m]))
      const next = order.flatMap((id) => byId.get(id) ?? [])
      for (const m of cur) if (!order.includes(m.id)) next.push(m)
      return { queues: { ...s.queues, [sessionId]: next } }
    })
    await client.request('queue.reorder', { sessionId, order })
  },
  queueSteer: async (sessionId, messageId) => {
    await client.request('queue.steer', { sessionId, messageId })
  },

  tune: async (sessionId, patch) => {
    await client.request('session.tune', { sessionId, ...patch })
    // The window changes NOW even though the harness reloads on the next
    // send — reflect the new ceiling immediately (context itself is kept:
    // the harness resumes the same conversation).
    if (patch.context1m !== undefined) {
      set((s) => {
        const cur = s.contexts[sessionId] as
          { totalTokens: number; maxTokens: number; percentage: number } | null | undefined
        if (!cur) return {}
        const maxTokens = patch.context1m ? 1_000_000 : 200_000
        return {
          contexts: {
            ...s.contexts,
            [sessionId]: {
              ...cur,
              maxTokens,
              percentage: (cur.totalTokens / maxTokens) * 100
            }
          }
        }
      })
    }
  },

  fetchContext: async (sessionId) => {
    const usage = await client.request<{ totalTokens: number } | null>('session.context', {
      sessionId
    })
    // Context can't change while a session idles — a null (cold handle,
    // control-channel timeout) must not clobber the last good snapshot.
    if (!usage) return
    const pending = pendingCompact.get(sessionId)
    if (pending) {
      // Halfway between post and pre splits stale from caught-up reports.
      if (usage.totalTokens > (pending.pre + pending.post) / 2) return
      pendingCompact.delete(sessionId)
    }
    set((s) => ({ contexts: { ...s.contexts, [sessionId]: usage } }))
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

  setRailOpen: (open) => {
    set({ railOpen: open })
    syncWatch(get())
  },
  setSettingsOpen: (open, jump) => set({ settingsOpen: open, settingsJump: jump ?? null }),
  clearSettingsJump: () => set({ settingsJump: null }),

  setTheme: (theme) => {
    localStorage.setItem(THEME_KEY, theme)
    applyTheme(theme)
    set({ theme })
  },

  fetchDoctor: async () => {
    const doctor = await client.request<DoctorReport>('doctor.get')
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
    const { selectedProjectId, projects, changes } = get()
    const project = projects.find((p) => p.id === selectedProjectId)
    if (!project) return
    const lineMatch = /:(\d+)(?::(\d+))?$/.exec(path)
    let rel = path.replace(/:\d+(?::\d+)?$/, '') // strip :line(:col)
    if (rel.startsWith('/')) {
      const root = project.cwd.endsWith('/') ? project.cwd : `${project.cwd}/`
      if (!rel.startsWith(root)) return
      rel = rel.slice(root.length)
    }
    // Changed files open as a diff surface (review loop); everything else
    // as a plain file surface, at the referenced line when one was given.
    if ((changes[project.id] ?? []).some((c) => c.path === rel)) {
      get().openDiffSurface(project.id, rel)
    } else {
      get().openFileSurface(
        project.id,
        rel,
        lineMatch ? { lineNumber: Number(lineMatch[1]), column: Number(lineMatch[2] ?? 1) } : null
      )
    }
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
