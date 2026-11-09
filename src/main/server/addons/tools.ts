import {
  ADDON_LIST_BRIDGE_TAIL,
  ADDON_LIST_CLAUDE_TAIL,
  addonCard,
  addonProblem,
  addonRemoveCard,
  removeAsks,
  scopeWords,
  type Writer
} from '@shared/addons'
import { LOCAL_PRINCIPAL, type Principal } from '@shared/capabilities'
import {
  AddonAddArgsSchema,
  AddonSpecSchema,
  type AddonRow,
  type AddonSpec,
  type AddonStatus,
  type AddonTool
} from '@shared/contract-addons'
import type { ProjectMeta } from '@shared/domain'
import type { SessionMeta } from '@shared/events'
import type { z } from 'zod'
import type { ApprovalRequest } from '../drivers/types'
import type { StoreRequest } from '../storeRpc'
import type { AddonCallResult } from './addonWire'
import { errorResult } from './downstream'
import { hasAddons, visibleAddons, visibleTools, workspaceIdOf } from './scope'

/**
 * The add-on tools threads get (plan section 7), one function each, called
 * by the claude handlers in apptools.ts and the bridge's `app.addon*` cases
 * in index.ts. addon_add always asks a person with an admin key first;
 * addon_remove asks unless a thread wrote the row last; addon_call follows
 * the thread's permission. Writes go through the store's RPC handler as the
 * local principal, so a Mac forwards them to the box.
 */

export const ADDON_ADD_WAIT_MS = 30_000

export interface AddonToolDeps {
  sessions: {
    get(id: string): SessionMeta | null
    getProject(id: string): ProjectMeta | null
    requestApproval(sessionId: string, req: ApprovalRequest): Promise<boolean>
  }
  store: {
    list(): AddonRow[]
    get(id: string): AddonRow | null
    byName(workspaceId: string | null, name: string): AddonRow | null
    status(): Record<string, AddonStatus>
    tools(id: string): { tools: AddonTool[] } | null
    onStatus(fn: () => void): () => void
  }
  host: { call(addonId: string, tool: string, args: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<AddonCallResult> }
  /** storeRpc.ts: addons.set and addons.remove, forwarded to the home on a Mac. */
  rpc: { handle(req: StoreRequest, principal: Principal): Promise<unknown> }
  environmentId: string
  workspaceName(id: string): string | null
  waitMs?: number
}

export type Lane = 'claude' | 'bridge'
type AddArgs = z.infer<typeof AddonAddArgsSchema>

const rootOf = (deps: AddonToolDeps, session: SessionMeta): SessionMeta => {
  let root = session
  for (let i = 0; root.parentId && i < 32; i++) root = deps.sessions.get(root.parentId) ?? root
  return root
}
const whereOf = (deps: AddonToolDeps, workspaceId: string | null): string => scopeWords(workspaceId ? (deps.workspaceName(workspaceId) ?? workspaceId) : null)
const runsOf = (spec: AddonSpec): string => addonCard(spec, { name: '' }, { workspaceName: null, replaces: false }).input.runs
const stateOf = (deps: AddonToolDeps, row: AddonRow): AddonStatus | null => (row.enabled ? (deps.store.status()[row.id] ?? null) : null)

export function appAddonList(deps: AddonToolDeps, caller: SessionMeta, lane: Lane): string {
  const workspaceId = workspaceIdOf(deps.sessions, caller)
  const rows = visibleAddons(deps.store, workspaceId).map((row) => {
    const status = stateOf(deps, row)
    return {
      name: row.name,
      where: whereOf(deps, row.workspaceId),
      runs: runsOf(row.spec),
      state: row.enabled ? (status?.state ?? 'starting') : 'off',
      tools: status?.tools ?? 0,
      ...(status?.detail ? { detail: status.detail } : {})
    }
  })
  return `${JSON.stringify({ addons: rows })}\n${lane === 'claude' ? ADDON_LIST_CLAUDE_TAIL : ADDON_LIST_BRIDGE_TAIL}`
}

/** The tool's arguments as a spec: auth defaults to fields when env or headers name values, else none. */
function specOf(args: AddArgs): AddonSpec | string {
  const fields = args.transport === 'stdio' ? (args.env ?? []) : (args.headers ?? [])
  const shared = { auth: args.auth ?? (fields.length ? 'fields' : 'none'), ...(args.platforms?.length ? { platforms: args.platforms } : {}) }
  const raw =
    args.transport === 'stdio'
      ? { transport: 'stdio', command: args.command ?? '', args: args.args ?? [], env: args.env ?? [], ...(args.tokenEnv ? { tokenEnv: args.tokenEnv } : {}), ...shared }
      : { transport: 'http', url: args.url ?? '', headers: args.headers ?? [], ...shared }
  const parsed = AddonSpecSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  const issue = parsed.error.issues[0]!
  return `${issue.path.join('.') || 'the add-on'}: ${issue.message}`
}

/** Wait until this host's status of the add-on leaves `starting`, or the deadline. */
function settled(deps: AddonToolDeps, id: string): Promise<void> {
  const done = (): boolean => {
    const s = deps.store.status()[id]
    return !!s && s.state !== 'starting'
  }
  if (done()) return Promise.resolve()
  return new Promise((resolve) => {
    const stop = deps.store.onStatus(() => {
      if (!done()) return
      clearTimeout(timer)
      stop()
      resolve()
    })
    const timer = setTimeout(() => {
      stop()
      resolve()
    }, deps.waitMs ?? ADDON_ADD_WAIT_MS)
  })
}

export async function appAddonAdd(deps: AddonToolDeps, caller: SessionMeta, raw: AddArgs, lane: Lane): Promise<string> {
  const args = AddonAddArgsSchema.parse(raw)
  const spec = specOf(args)
  if (typeof spec === 'string') return `refused: ${spec}`
  const problem = addonProblem(spec, args.name)
  if (problem) return `refused: ${problem}`
  const callerWorkspace = workspaceIdOf(deps.sessions, caller)
  const workspaceId = args.scope === 'global' ? null : callerWorkspace
  const existing = deps.store.byName(workspaceId, args.name)
  const card = addonCard(spec, { name: args.name }, { workspaceName: workspaceId ? (deps.workspaceName(workspaceId) ?? workspaceId) : null, replaces: !!existing })
  const allowed = await deps.sessions.requestApproval(caller.id, { toolName: 'addon_add', title: card.title, input: card.input })
  if (!allowed) return 'refused: the person did not allow it; nothing was added'
  const root = rootOf(deps, caller)
  const writer: Writer = { kind: 'thread', sessionId: root.id, environmentId: deps.environmentId, title: (root.title ?? '').slice(0, 200) }
  const had = hasAddons(deps.store, callerWorkspace)
  let row: AddonRow
  try {
    const answer = (await deps.rpc.handle(
      {
        method: 'addons.set',
        params: {
          addon: {
            ...(existing ? { id: existing.id } : {}),
            name: args.name,
            workspaceId,
            description: args.description ?? existing?.description ?? '',
            spec,
            enabled: true,
            addedBy: existing?.addedBy ?? writer,
            writtenBy: writer
          }
        }
      },
      LOCAL_PRINCIPAL
    )) as { addon: AddonRow }
    row = answer.addon
  } catch (error) {
    const message = (error as Error).message
    return message.startsWith('refused:') ? message : `refused: ${message}`
  }
  await settled(deps, row.id)
  const status = deps.store.status()[row.id]
  const state = status?.state ?? 'starting'
  const tools = (deps.store.tools(row.id)?.tools ?? []).slice(0, 20).map((t) => t.exposed)
  const flipped = !had && hasAddons(deps.store, callerWorkspace)
  const note =
    state !== 'ready'
      ? 'Its tools list once it is ready on this host; addon_list shows its state.'
      : lane === 'claude'
        ? 'Its tools are in your tool search now.'
        : flipped
          ? 'addon_find lists them from your next turn.'
          : 'addon_find lists them now.'
  return JSON.stringify({ name: row.name, id: row.id, where: whereOf(deps, row.workspaceId), state, tools, ...(status?.detail ? { detail: status.detail } : {}), note })
}

export async function appAddonRemove(deps: AddonToolDeps, caller: SessionMeta, args: { name: string; scope?: 'workspace' | 'global' }): Promise<string> {
  const workspaceId = workspaceIdOf(deps.sessions, caller)
  const local = workspaceId ? deps.store.byName(workspaceId, args.name) : null
  const row = args.scope === 'global' ? deps.store.byName(null, args.name) : args.scope === 'workspace' ? local : (local ?? deps.store.byName(null, args.name))
  if (!row) return `refused: no add-on ${args.name} here; addon_list shows them`
  const where = whereOf(deps, row.workspaceId)
  if (removeAsks(row)) {
    const card = addonRemoveCard(row, { workspaceName: row.workspaceId ? (deps.workspaceName(row.workspaceId) ?? row.workspaceId) : null })
    if (!(await deps.sessions.requestApproval(caller.id, { toolName: 'addon_remove', title: card.title, input: card.input })))
      return 'refused: the person did not allow it; nothing was removed'
  }
  try {
    await deps.rpc.handle({ method: 'addons.remove', params: { id: row.id } }, LOCAL_PRINCIPAL)
  } catch (error) {
    const message = (error as Error).message
    return message.startsWith('refused:') ? message : `refused: ${message}`
  }
  return JSON.stringify({ removed: row.name, where })
}

const words = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

export function appAddonFind(deps: AddonToolDeps, caller: SessionMeta, args: { query?: string; addon?: string }): string {
  const workspaceId = workspaceIdOf(deps.sessions, caller)
  if (!args.query?.trim()) {
    const rows = visibleAddons(deps.store, workspaceId).filter((r) => !args.addon || r.name === args.addon)
    return JSON.stringify(
      rows.map((row) => ({
        addon: row.name,
        state: row.enabled ? (stateOf(deps, row)?.state ?? 'starting') : 'off',
        tools: stateOf(deps, row)?.state === 'ready' ? (deps.store.tools(row.id)?.tools ?? []).map((t) => t.exposed) : []
      }))
    )
  }
  const want = words(args.query)
  const ranked = visibleTools(deps.store, workspaceId)
    .filter(({ row }) => !args.addon || row.name === args.addon)
    .flatMap(({ tool }) => {
      const name = new Set(words(tool.exposed))
      const description = new Set(words(tool.description))
      const inName = want.filter((w) => [...name].some((n) => n.includes(w))).length
      const inDescription = want.filter((w) => [...description].some((d) => d.includes(w))).length
      const every = want.every((w) => [...name, ...description].some((x) => x.includes(w)))
      return every ? [{ tool, inName, inDescription }] : []
    })
    .sort((a, b) => b.inName - a.inName || b.inDescription - a.inDescription || (a.tool.exposed < b.tool.exposed ? -1 : 1))
    .slice(0, 10)
  return JSON.stringify(ranked.map(({ tool }) => ({ tool: tool.exposed, description: tool.description, inputSchema: tool.inputSchema })))
}

export async function appAddonCall(
  deps: AddonToolDeps,
  caller: SessionMeta,
  args: { tool: string; arguments?: Record<string, unknown> },
  signal?: AbortSignal
): Promise<AddonCallResult> {
  const workspaceId = workspaceIdOf(deps.sessions, caller)
  const hit = visibleTools(deps.store, workspaceId).find(({ tool }) => tool.exposed === args.tool)
  if (!hit) {
    const row = visibleAddons(deps.store, workspaceId).find((r) => args.tool.startsWith(`${r.name}__`))
    const status = row ? stateOf(deps, row) : null
    if (row && status?.state !== 'ready') return errorResult(`${row.name} is ${row.enabled ? (status?.state ?? 'starting') : 'off'}${status?.detail ? `: ${status.detail}` : ''}`)
    return errorResult(`No add-on tool ${args.tool}; addon_find lists them`)
  }
  const input = args.arguments ?? {}
  const asks = caller.permission === 'safe' || (caller.permission === 'edits' && !hit.tool.readOnly)
  if (asks && !(await deps.sessions.requestApproval(caller.id, { toolName: hit.tool.exposed, title: `Use ${hit.tool.name} from ${hit.row.name}`, input })))
    return errorResult('The person did not allow it')
  try {
    return await deps.host.call(hit.row.id, hit.tool.name, input, { signal })
  } catch (error) {
    return errorResult((error as Error).message)
  }
}
