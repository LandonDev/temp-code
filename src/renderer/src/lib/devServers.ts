import { useEffect, useMemo } from 'react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { DevRun, DevRunPush, DevTarget } from '@server/shared/contract-devservers'
import type { ThreadResource } from '@server/shared/contract-resources'
import { currentDockCwd } from '../stores/project'
import { currentDock, terminals } from '../stores/terminals'
import { focus } from '../stores/focus'
import type { DevLogSource, FilePaneTab } from './layout'
import { selectDockTerminal, withDockOpen } from './projectTerminal'
import { looksLikeProject } from './recents'
import { sessionStore, useServerSessions } from './tcserver/store'
import { threadResourcesStore } from './threadResources'
import { registry } from './connection/registry'
import type { EnvLink } from './connection/link'
import { useEnvironments, useEnvironmentStatuses } from './connection/status'
import { pairWorkspaces, partnersOf } from './projectPairs'
import type { ProjectMeta } from './tcserver/types'
import { useProjects, useWorkspaces } from './tcserver/workspaces'

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

const attached = new WeakSet<EnvLink>()
function attach(link: EnvLink): void {
  if (attached.has(link)) return
  attached.add(link)
  link.onPush((push) => {
    if (push.push === 'dev-run') applyDevRunPush(link.environmentId, push)
  })
}

let started = false
function start(): void {
  if (started) return
  started = true
  for (const link of registry.links()) attach(link)
  registry.onLink((link, event) => {
    if (event === 'added') attach(link)
  })
}

export async function loadDevTargets(environmentId: string, projectId: string): Promise<void> {
  start()
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
  start()
  const { run } = await registry.linkOf(environmentId).request<{ run: DevRun }>(method, params)
  applyDevRunPush(environmentId, { push: 'dev-run', projectId: run.projectId, run, lines: [] })
  return run
}

export const startDevServer = (environmentId: string, projectId: string, targetId: string) => act(environmentId, 'devServer.start', { projectId, targetId })
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

/** The line a target reads as in the menu: "web · dev", the framework after it when it names one. */
export function targetLabel(t: Pick<DevTarget, 'name' | 'script' | 'framework' | 'kind'>): string {
  if (t.kind === 'ios') return `${t.name} · iOS`
  return `${t.name} · ${t.script}`
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

/** A dev server a thread's agent opened: a live `port` row on its host's ledger. */
export interface AgentServer {
  row: ThreadResource
  /** The host the thread runs on (the link that serves its log). */
  environmentId: string
  /** The thread's title. */
  title: string
}

/** Every live port the project's threads opened, on every host with a copy of it, newest first. */
export function useAgentServers(hosts: readonly DevHost[]): AgentServer[] {
  const bySession = useStore(threadResourcesStore, (s) => s.bySession)
  const sessions = useServerSessions()
  return useMemo(() => {
    const copies = new Set(hosts.flatMap((h) => (h.projectId ? [keyOf(h.environmentId, h.projectId)] : [])))
    const out: AgentServer[] = []
    for (const session of sessions) {
      const environmentId = sessionStore.environmentOf(session.id)
      if (!environmentId || !session.projectId || !copies.has(keyOf(environmentId, session.projectId))) continue
      for (const row of bySession[session.id] ?? [])
        if (row.kind === 'port' && !row.removedAt && !row.removeRequestedAt) out.push({ row, environmentId, title: session.title })
    }
    return out.sort((a, b) => b.row.createdAt - a.row.createdAt)
  }, [hosts, bySession, sessions])
}

/** Every run of the project on every host with a copy, newest first. */
export function useAllDevRuns(hosts: readonly DevHost[]): (DevRun & { environmentId: string })[] {
  const runs = useStore(store, (s) => s.runs)
  return useMemo(
    () =>
      hosts
        .flatMap((h) => (h.projectId ? (runs[keyOf(h.environmentId, h.projectId)] ?? EMPTY_RUNS).map((r) => ({ ...r, environmentId: h.environmentId })) : []))
        .sort((a, b) => b.startedAt - a.startedAt),
    [hosts, runs]
  )
}

const sameSource = (a: DevLogSource, b: DevLogSource): boolean =>
  a.environmentId === b.environmentId && a.runId === b.runId && a.resourceId === b.resourceId

/** Show a dev server's console as a tab in the project's terminal dock, reusing its tab when one is open. */
export function openDevLog(source: DevLogSource, title: string): void {
  const projectPath = currentDockCwd()
  if (!looksLikeProject(projectPath)) return
  const existing = currentDock(projectPath)?.pane.files.find((f) => f.devLog && sameSource(f.devLog, source))
  if (existing) terminals.updateDock(projectPath, (dock) => withDockOpen(selectDockTerminal(dock, existing.id), true))
  else {
    const file: FilePaneTab = { id: crypto.randomUUID(), path: title, cwd: projectPath, terminal: true, devLog: source }
    terminals.openTerminal(projectPath, file)
  }
  focus.enterProjectTerminal()
}
