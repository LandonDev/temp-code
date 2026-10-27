import { useEffect, useMemo } from 'react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { DevRun, DevRunPush, DevTarget } from '@server/shared/contract-devservers'
import type { ThreadResource } from '@server/shared/contract-resources'
import type { PortForwardInfo } from '@server/shared/contract-ports'
import { notDevServer } from '@server/shared/devServerRules'
import { commandWords, serverWords } from '@server/shared/devServerWords'
import { sessionStore, useServerSessions } from './tcserver/store'
import { removeThreadResources, startThreadResources, threadResourcesStore } from './threadResources'
import { registry } from './connection/registry'
import type { EnvLink } from './connection/link'
import { useEnvironments, useEnvironmentStatuses } from './connection/status'
import { pairWorkspaces, partnersOf } from './projectPairs'
import type { ProjectMeta } from './tcserver/types'
import { useProjects, useWorkspaces } from './tcserver/workspaces'
import { sameProjectPath } from './recents'
import { useDevPane } from './devPane'

/**
 * The Dev Server button's state (docs/box.md "Dev servers on the box"): per
 * host and project, what it can serve (`devServer.targets`), its runs, and
 * each run's log, kept current by the host's `dev-run` push (the run's state
 * plus new lines, like the Build rail's). A project with a copy on another
 * host (lib/projectPairs.ts) can run there; each host answers for its own
 * copy, so the choice of host is the choice of link and project id.
 */

const LOG_CAP = 3_000

type Key = string
const keyOf = (environmentId: string, projectId: string): Key => `${environmentId}/${projectId}`

interface State {
  /** undefined: not asked yet; null: the host has no such method (older). */
  targets: Record<Key, DevTarget[] | null>
  runs: Record<Key, DevRun[]>
  logs: Record<string, string[]>
}
const store = createStore<State>(() => ({ targets: {}, runs: {}, logs: {} }))
export const devServerStore = store

function upsert(runs: readonly DevRun[], run: DevRun): DevRun[] {
  const rest = runs.filter((r) => r.id !== run.id && !(r.targetId === run.targetId && r.status !== 'running'))
  return [run, ...rest].sort((a, b) => b.startedAt - a.startedAt)
}

/** A `dev-run` push: the run replaces its row (a target's finished runs give way to its new one), its lines append. */
export function applyDevRunPush(environmentId: string, push: DevRunPush): void {
  const key = keyOf(environmentId, push.projectId)
  store.setState((s) => {
    const prior = s.logs[push.run.id] ?? []
    const lines = push.lines.length ? [...prior, ...push.lines].slice(-LOG_CAP) : prior
    return {
      runs: { ...s.runs, [key]: upsert(s.runs[key] ?? [], push.run) },
      logs: push.lines.length || !(push.run.id in s.logs) ? { ...s.logs, [push.run.id]: lines } : s.logs
    }
  })
}

/** A host's `devServer.runs` answer: its running runs are these, any project; finished ones stay for their logs. */
export function applyHostRuns(environmentId: string, live: readonly DevRun[]): void {
  store.setState((s) => {
    const runs: State['runs'] = {}
    for (const [key, list] of Object.entries(s.runs))
      runs[key] = key.startsWith(`${environmentId}/`) ? list.filter((r) => r.status !== 'running' || live.some((l) => l.id === r.id)) : list
    for (const run of live) {
      const key = keyOf(environmentId, run.projectId)
      runs[key] = upsert(runs[key] ?? [], run)
    }
    return { runs }
  })
}

async function loadHostRuns(link: EnvLink): Promise<void> {
  try {
    const { runs } = await link.request<{ runs: DevRun[] }>('devServer.runs', {})
    applyHostRuns(link.environmentId, runs)
  } catch {
    /* an older host without the method: its runs arrive as pushes and per-project reads */
  }
}

const attached = new WeakSet<EnvLink>()
function attach(link: EnvLink): void {
  if (attached.has(link)) return
  attached.add(link)
  link.onPush((push) => {
    if (push.push === 'dev-run') applyDevRunPush(link.environmentId, push)
  })
  link.onOpen(() => void loadHostRuns(link))
  if (link.connected) void loadHostRuns(link)
}

let started = false
/** Hear every host's `dev-run` push and read its running runs once per link-up; idempotent. */
export function startDevServers(): void {
  if (started) return
  started = true
  for (const link of registry.links()) attach(link)
  registry.onLink((link, event) => {
    if (event === 'added') attach(link)
  })
}

export async function loadDevTargets(environmentId: string, projectId: string): Promise<void> {
  startDevServers()
  const key = keyOf(environmentId, projectId)
  try {
    const { targets, runs } = await registry.linkOf(environmentId).request<{ targets: DevTarget[]; runs: DevRun[] }>('devServer.targets', { projectId })
    store.setState((s) => ({ targets: { ...s.targets, [key]: targets }, runs: { ...s.runs, [key]: runs } }))
  } catch {
    store.setState((s) => ({ targets: { ...s.targets, [key]: null } }))
  }
}

/** The console's replay: the host's buffered log for a run this window joined late. */
export async function loadDevLog(environmentId: string, runId: string): Promise<void> {
  const { run, lines } = await registry.linkOf(environmentId).request<{ run: DevRun; lines: string[] }>('devServer.log', { runId })
  store.setState((s) => ({ logs: { ...s.logs, [runId]: lines } }))
  applyDevRunPush(environmentId, { push: 'dev-run', projectId: run.projectId, run, lines: [] })
}

async function act(environmentId: string, method: 'devServer.start' | 'devServer.stop' | 'devServer.restart', params: object): Promise<DevRun> {
  startDevServers()
  const { run } = await registry.linkOf(environmentId).request<{ run: DevRun }>(method, params)
  applyDevRunPush(environmentId, { push: 'dev-run', projectId: run.projectId, run, lines: [] })
  return run
}

export const startDevServer = (environmentId: string, projectId: string, targetId: string, sessionId?: string | null) =>
  act(environmentId, 'devServer.start', { projectId, targetId, ...(sessionId ? { sessionId } : {}) })
export const stopDevServer = (environmentId: string, runId: string) => act(environmentId, 'devServer.stop', { runId })
export const restartDevServer = (environmentId: string, runId: string) => act(environmentId, 'devServer.restart', { runId })

const EMPTY_RUNS: DevRun[] = []
const EMPTY_LINES: string[] = []

/** A host's targets for a project (undefined while loading, null when the host cannot say), read once per mount. */
export function useDevTargets(environmentId: string | null, projectId: string | null): DevTarget[] | null | undefined {
  useEffect(() => {
    if (environmentId && projectId) void loadDevTargets(environmentId, projectId)
  }, [environmentId, projectId])
  return useStore(store, (s) => (environmentId && projectId ? s.targets[keyOf(environmentId, projectId)] : undefined))
}

export function useDevRuns(environmentId: string | null, projectId: string | null): DevRun[] {
  return useStore(store, (s) => (environmentId && projectId ? (s.runs[keyOf(environmentId, projectId)] ?? EMPTY_RUNS) : EMPTY_RUNS))
}

export function useDevLog(runId: string | null): string[] {
  return useStore(store, (s) => (runId ? (s.logs[runId] ?? EMPTY_LINES) : EMPTY_LINES))
}

export interface DevHost {
  environmentId: string
  name: string
  /** The project's copy there; null when that host has no copy (the choice shows, held). */
  projectId: string | null
}

/**
 * Where a project can run: its own host first, then every other host whose
 * link is open and that has a copy of it (the same repo, else the same folder
 * name), each with that copy's project id.
 */
export function devHosts(
  project: Pick<ProjectMeta, 'id' | 'environmentId' | 'cwd'>,
  environments: readonly { id: string; name: string }[],
  isOpen: (id: string) => boolean,
  pairs: ReturnType<typeof pairWorkspaces>,
  projects: readonly Pick<ProjectMeta, 'id' | 'environmentId' | 'cwd'>[]
): DevHost[] {
  const strip = (p: string) => p.replace(/\/+$/, '')
  const partners = partnersOf(pairs, project.environmentId, project.cwd)
  const out: DevHost[] = []
  for (const env of environments) {
    if (env.id === 'web') continue
    if (env.id === project.environmentId) {
      out.unshift({ environmentId: env.id, name: env.name, projectId: project.id })
      continue
    }
    if (!isOpen(env.id)) continue
    const partner = partners.find((m) => m.environmentId === env.id)
    if (!partner) continue
    const copy = projects.find((p) => p.environmentId === env.id && strip(p.cwd) === partner.cwd)
    out.push({ environmentId: env.id, name: env.name, projectId: copy?.id ?? null })
  }
  return out
}

export function useDevHosts(project: Pick<ProjectMeta, 'id' | 'environmentId' | 'cwd'> | undefined): DevHost[] {
  const environments = useEnvironments()
  const statuses = useEnvironmentStatuses()
  const workspaces = useWorkspaces()
  const projects = useProjects()
  return useMemo(
    () =>
      project
        ? devHosts(project, environments, (id) => statuses.get(id)?.transport === 'open', pairWorkspaces(workspaces), projects)
        : [],
    [project, environments, statuses, workspaces, projects]
  )
}

/** A target as the starter lists it: its app and what it starts, "web (Vite dev server)". */
export function targetLabel(t: Pick<DevTarget, 'name' | 'what'>): string {
  return `${t.name} (${t.what})`
}

const copiesOf = (hosts: readonly DevHost[]): Key[] => hosts.flatMap((h) => (h.projectId ? [keyOf(h.environmentId, h.projectId)] : []))

/** Whether a dev server of the project runs on any of its hosts (the rail tab's and the button's dot). */
export function useDevRunning(projectId: string | null | undefined): boolean {
  const project = useProjects().find((p) => p.id === projectId)
  const keys = copiesOf(useDevHosts(project))
  return useStore(store, (s) => keys.some((k) => (s.runs[k] ?? EMPTY_RUNS).some((r) => r.status === 'running')))
}

/** Whether any host can serve the project: the Dev Server button shows only then. Asks each host once. */
export function useDevServable(project: Pick<ProjectMeta, 'id' | 'environmentId' | 'cwd'> | undefined): boolean {
  const hosts = useDevHosts(project)
  const keys = copiesOf(hosts)
  const sig = keys.join('|')
  useEffect(() => {
    const known = store.getState().targets
    for (const h of hosts) if (h.projectId && !(keyOf(h.environmentId, h.projectId) in known)) void loadDevTargets(h.environmentId, h.projectId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig])
  return useStore(store, (s) => keys.some((k) => (s.targets[k]?.length ?? 0) > 0))
}

/**
 * One dev server live on a host, as the Dev servers pane and a thread's
 * Resources list it: a running Dev Server run, or a `port` row on a thread's
 * ledger that still listens and passes the shared rules
 * (src/shared/devServerRules.ts). The host drops a row the moment nothing
 * listens; so does this list.
 */
export interface LiveServer {
  /** `<host>/<run or ledger row id>`: stable across windows. */
  key: string
  /** The host whose link serves the log and takes the Stop. */
  environmentId: string
  /** What it is, in plain words: "Vite dev server", "Expo app". */
  title: string
  /** The thread it belongs to (the one that opened it, or the one on screen when Run started it); null for none. */
  sessionId: string | null
  /** That thread's title, or for a run with no thread the project's name: the group heading. */
  owner: string
  /** The port, and the host it lives on (a Mac bridge row lives on the Mac), with its forwards. */
  port: { number: number; environmentId: string; forwards: PortForwardInfo[] | undefined } | null
  runId: string | null
  resource: { id: string; sessionId: string } | null
  startedAt: number
  /** Stop was asked and the host has not dropped it yet: the reason it waits ("Mac offline, waiting"), else ''. */
  stopping?: string
}

export interface LiveServerSources {
  runs: Record<string, DevRun[]>
  resources: Record<string, ThreadResource[]>
  /** A thread's host, project and title; null for a thread this window does not know. */
  thread: (sessionId: string) => { environmentId: string; projectId: string | null; title: string } | null
  projectName: (environmentId: string, projectId: string) => string | null
}

/**
 * Every live dev server across the hosts, newest first, each once: a port a
 * run holds is the run's, even when the sweep also filed it on a thread.
 */
export function liveServers(src: LiveServerSources): LiveServer[] {
  const out: LiveServer[] = []
  const held = new Set<string>()
  for (const [key, list] of Object.entries(src.runs)) {
    const environmentId = key.slice(0, key.indexOf('/'))
    for (const run of list) {
      if (run.status !== 'running') continue
      const p = run.ports[0]
      for (const port of run.ports) held.add(`${environmentId}:${port.port}`)
      const sessionId = run.sessionId ?? null
      out.push({
        key: `${environmentId}/${run.id}`,
        environmentId,
        title: run.what ?? (run.kind === 'ios' ? serverWords('xcode') : commandWords(run.command)),
        sessionId,
        owner: (sessionId ? src.thread(sessionId)?.title : null) ?? src.projectName(environmentId, run.projectId) ?? run.name,
        port: p ? { number: p.port, environmentId, forwards: p.forwards } : null,
        runId: run.id,
        resource: null,
        startedAt: run.startedAt
      })
    }
  }
  for (const [sessionId, rows] of Object.entries(src.resources)) {
    const thread = src.thread(sessionId)
    if (!thread) continue
    for (const row of rows) {
      if (row.kind !== 'port' || row.removedAt) continue
      const number = Number(row.identifier)
      if (notDevServer(number, null, row.label) || held.has(`${row.environmentId}:${number}`)) continue
      out.push({
        key: `${thread.environmentId}/${row.id}`,
        environmentId: thread.environmentId,
        title: commandWords(row.label),
        sessionId,
        owner: thread.title,
        port: { number, environmentId: row.environmentId, forwards: row.forwards },
        runId: null,
        resource: { id: row.id, sessionId },
        startedAt: row.createdAt,
        ...(row.removeRequestedAt ? { stopping: row.note ?? '' } : {})
      })
    }
  }
  return out.sort((a, b) => b.startedAt - a.startedAt)
}

/** The servers under their threads: groups in the order of their newest server, each group newest first. */
export function serverGroups(servers: readonly LiveServer[]): { key: string; owner: string; servers: LiveServer[] }[] {
  const groups = new Map<string, { key: string; owner: string; servers: LiveServer[] }>()
  for (const server of servers) {
    const key = server.sessionId ?? `owner:${server.owner}`
    const group = groups.get(key) ?? { key, owner: server.owner, servers: [] }
    group.servers.push(server)
    groups.set(key, group)
  }
  return [...groups.values()]
}

/** The row the pane shows: the one picked while it is still live, else the newest. */
export function shownServer(servers: readonly LiveServer[], picked: string | null): LiveServer | null {
  return servers.find((s) => s.key === picked) ?? servers[0] ?? null
}

/** The live dev servers, kept current by the hosts' pushes. */
export function useLiveDevServers(): LiveServer[] {
  useEffect(() => {
    startDevServers()
    startThreadResources()
  }, [])
  const runs = useStore(store, (s) => s.runs)
  const resources = useStore(threadResourcesStore, (s) => s.bySession)
  const sessions = useServerSessions()
  const projects = useProjects()
  return useMemo(() => {
    const byId = new Map(sessions.map((s) => [s.id, s]))
    return liveServers({
      runs,
      resources,
      thread: (id) => {
        const s = byId.get(id)
        const environmentId = s ? sessionStore.environmentOf(id) : null
        return s && environmentId ? { environmentId, projectId: s.projectId ?? null, title: s.title } : null
      },
      projectName: (environmentId, projectId) => projects.find((p) => p.id === projectId && p.environmentId === environmentId)?.name ?? null
    })
  }, [runs, resources, sessions, projects])
}

/** Stop a live server on its host: a run's process group, or the ledger row's process. Throws when it did not stop (failed, or waiting for its host). */
export async function stopLiveServer(server: LiveServer): Promise<void> {
  if (server.runId) await stopDevServer(server.environmentId, server.runId)
  else if (server.resource) {
    const [result] = await removeThreadResources(server.resource.sessionId, [server.resource.id])
    if (result && result.outcome !== 'removed') throw new Error(result.note ?? (result.outcome === 'waiting' ? 'Waiting for its host' : 'It did not stop'))
  }
}

/**
 * Whether the bottom dock shows its Dev servers tab, and the count beside it:
 * only when a host can serve the project, a server runs anywhere, or the pane
 * is open (so the tab the person is on never vanishes under them).
 */
export function devTabOf({ servable, count, open }: { servable: boolean; count: number; open: boolean }): { count: number } | null {
  return servable || count > 0 || open ? { count } : null
}

/** The project a dock at `projectPath` serves: this machine's project at that folder, else any host's. */
export function useDockProject(projectPath: string): ProjectMeta | undefined {
  const projects = useProjects()
  const local = registry.primary().environmentId
  return useMemo(() => {
    const here = projects.filter((p) => !p.archived && p.cwd && sameProjectPath(p.cwd, projectPath))
    return here.find((p) => p.environmentId === local) ?? here[0]
  }, [projects, projectPath, local])
}

/** `devTabOf` for the dock of `projectPath`. */
export function useDevTab(projectPath: string): { count: number } | null {
  const project = useDockProject(projectPath)
  const servable = useDevServable(project)
  const count = useLiveDevServers().length
  const open = useDevPane((s) => s.open)
  return devTabOf({ servable, count, open })
}

/**
 * One dev server per thread (docs/box.md "Dev servers on the box"): Run for
 * a thread that already has one asks whether to replace it or start another
 * for a different feature; a thread's own servers (its shell's port rows)
 * count. `start` when it has none or no thread is on screen.
 */
export function runChoice(servers: readonly LiveServer[], sessionId: string | null): 'start' | 'ask' {
  return sessionId && servers.some((s) => s.sessionId === sessionId) ? 'ask' : 'start'
}

/** The root of `id`'s thread: servers belong to the thread, not to a subagent of it. */
export function threadRoot(id: string, parentOf: (id: string) => string | null | undefined): string {
  let at = id
  for (let i = 0; i < 32; i++) {
    const parent = parentOf(at)
    if (!parent) return at
    at = parent
  }
  return at
}
