import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { Principal } from '@shared/capabilities'
import type { AddonSpec, AddonTool } from '@shared/contract-addons'
import type { SessionMeta } from '@shared/events'
import { AddonStore } from '../addonStore'
import type { ApprovalRequest } from '../drivers/types'
import { SkillStore } from '../skillStore'
import { storeRpc, type StoreRequest } from '../storeRpc'
import type { AddonCallResult } from './addonWire'
import { appAddonAdd, appAddonCall, appAddonFind, appAddonList, appAddonRemove, type AddonToolDeps } from './tools'

const stdio: AddonSpec = { transport: 'stdio', command: 'npx', args: ['-y', 'fake'], env: ['FAKE_TOKEN'], auth: 'fields' }
const person = { kind: 'person' as const }
const tool = (addon: string, name: string, description: string, readOnly?: boolean): AddonTool => ({
  name,
  exposed: `${addon}__${name}`,
  description,
  inputSchema: { type: 'object', properties: {} },
  ...(readOnly !== undefined ? { readOnly } : {})
})

function setup(opts: { allow?: boolean; permission?: SessionMeta['permission']; onSet?: (store: AddonStore, id: string) => void } = {}) {
  const db = new DatabaseSync(':memory:')
  const store = new AddonStore(db)
  const rpc = storeRpc({ addons: store, skills: new SkillStore(db), sync: null })
  const rpcCalls: { req: StoreRequest; principal: Principal }[] = []
  const cards: ApprovalRequest[] = []
  const hostCalls: { addonId: string; tool: string; args: Record<string, unknown> }[] = []
  const root = { id: 'root', parentId: null, title: 'Wire the tracker', projectId: 'p1', workspaceId: null, permission: opts.permission ?? 'auto' } as unknown as SessionMeta
  const child = { ...root, id: 'child', parentId: 'root', title: 'A subagent' } as SessionMeta
  const sessions = new Map([root, child].map((s) => [s.id, s]))
  store.onChange(() => {
    for (const row of store.list()) if (!store.status()[row.id]) setTimeout(() => opts.onSet?.(store, row.id), 5)
  })
  const deps: AddonToolDeps = {
    sessions: {
      get: (id) => sessions.get(id) ?? null,
      getProject: (id) => (id === 'p1' ? ({ id: 'p1', workspaceId: 'ws1' } as never) : null),
      requestApproval: async (_id, req) => {
        cards.push(req)
        return opts.allow ?? true
      }
    },
    store,
    host: {
      call: async (addonId, toolName, args): Promise<AddonCallResult> => {
        hostCalls.push({ addonId, tool: toolName, args })
        return { content: [{ type: 'text', text: 'done' }], structuredContent: { ok: true } }
      }
    },
    rpc: {
      handle: (req, principal) => {
        rpcCalls.push({ req, principal })
        return rpc.handle(req, principal)
      }
    },
    environmentId: 'env_box',
    workspaceName: (id) => (id === 'ws1' ? 'temp-code' : null),
    waitMs: 500
  }
  const ready = (id: string, tools: AddonTool[]) => {
    store.setTools(id, tools)
    store.setStatus(id, { state: 'ready', tools: tools.length, at: 1 })
  }
  return { deps, store, rpcCalls, cards, hostCalls, root, child, ready }
}

describe('addon_add', () => {
  it('refuses a bad name or a secret in the command before any card', async () => {
    const s = setup()
    expect(await appAddonAdd(s.deps, s.child, { name: 'Bad Name', transport: 'stdio', command: 'npx' }, 'claude')).toMatch(/^refused: name takes lowercase/)
    expect(await appAddonAdd(s.deps, s.child, { name: 'gh', transport: 'stdio', command: 'npx', args: ['ghp_abcdefghijklmnopqrstuvwxyz0123'] }, 'claude')).toMatch(/^refused: args\[0\] looks like a secret/)
    expect(await appAddonAdd(s.deps, s.child, { name: 'web', transport: 'http' }, 'claude')).toMatch(/^refused: url/)
    expect(s.cards).toEqual([])
  })

  it('asks with the card, and a deny (the person\'s, or Away\'s) adds nothing', async () => {
    const s = setup({ allow: false })
    expect(await appAddonAdd(s.deps, s.child, { name: 'fake', transport: 'stdio', command: 'npx', args: ['-y', 'fake'], env: ['FAKE_TOKEN'] }, 'claude')).toBe('refused: the person did not allow it; nothing was added')
    expect(s.cards).toEqual([
      { toolName: 'addon_add', title: 'Add the add-on fake', input: { runs: 'npx -y fake', where: 'temp-code', hosts: 'Every host', needs: 'Values for FAKE_TOKEN', note: 'It runs as you on every host that starts it.' } }
    ])
    expect(s.store.list()).toEqual([])
  })

  it('writes through addons.set as the local principal with the root thread as writer, waits for ready and names the tools', async () => {
    const s = setup({ onSet: (store, id) => ((store.setTools(id, [tool('fake', 'echo', 'Echo')]), store.setStatus(id, { state: 'ready', tools: 1, at: 1 }))) })
    const answer = JSON.parse(await appAddonAdd(s.deps, s.child, { name: 'fake', transport: 'stdio', command: 'npx', args: ['-y', 'fake'], env: ['FAKE_TOKEN'] }, 'claude'))
    expect(answer).toMatchObject({ name: 'fake', where: 'temp-code', state: 'ready', tools: ['fake__echo'], note: 'Its tools are in your tool search now.' })
    expect(s.rpcCalls[0]!.principal).toEqual({ kind: 'local' })
    const row = s.store.list()[0]!
    expect(row.workspaceId).toBe('ws1')
    expect(row.spec).toMatchObject({ auth: 'fields' })
    expect(row.writtenBy).toEqual({ kind: 'thread', sessionId: 'root', environmentId: 'env_box', title: 'Wire the tracker' })
    expect(row.addedBy).toEqual(row.writtenBy)
  })

  it('answers a needs-grant add-on with its detail, and the bridge says when addon_find lists it', async () => {
    const s = setup({ onSet: (store, id) => store.setStatus(id, { state: 'needs-grant', tools: 0, detail: 'Needs values for FAKE_TOKEN', at: 1 }) })
    const answer = JSON.parse(await appAddonAdd(s.deps, s.root, { name: 'fake', transport: 'stdio', command: 'npx', env: ['FAKE_TOKEN'], scope: 'global' }, 'bridge'))
    expect(answer).toMatchObject({ where: 'Every workspace', state: 'needs-grant', detail: 'Needs values for FAKE_TOKEN', tools: [] })
    expect(answer.note).toMatch(/once it is ready/)
    const t = setup({ onSet: (store, id) => ((store.setTools(id, [tool('fake', 'echo', 'Echo')]), store.setStatus(id, { state: 'ready', tools: 1, at: 1 }))) })
    expect(JSON.parse(await appAddonAdd(t.deps, t.root, { name: 'fake', transport: 'stdio', command: 'npx', env: ['FAKE_TOKEN'] }, 'bridge')).note).toBe('addon_find lists them from your next turn.')
  })
})

describe('addon_remove and addon_list', () => {
  it('removes a thread-written row without a card and asks for a person\'s', async () => {
    const s = setup()
    s.store.set({ name: 'mine', workspaceId: 'ws1', spec: stdio, writtenBy: { kind: 'thread', sessionId: 'x', environmentId: 'e', title: 't' } }, person)
    s.store.set({ name: 'theirs', workspaceId: null, spec: stdio }, person)
    expect(await appAddonRemove(s.deps, s.root, { name: 'nope' })).toBe('refused: no add-on nope here; addon_list shows them')
    expect(JSON.parse(await appAddonRemove(s.deps, s.root, { name: 'mine' }))).toEqual({ removed: 'mine', where: 'temp-code' })
    expect(s.cards).toEqual([])
    expect(JSON.parse(await appAddonRemove(s.deps, s.root, { name: 'theirs' }))).toEqual({ removed: 'theirs', where: 'Every workspace' })
    expect(s.cards).toEqual([{ toolName: 'addon_remove', title: 'Remove the add-on theirs', input: { where: 'Every workspace', addedBy: 'You' } }])
    expect(s.store.list()).toEqual([])
  })

  it('lists the visible rows with their state and the lane\'s tail', () => {
    const s = setup()
    const a = s.store.set({ name: 'a', workspaceId: null, spec: stdio }, person)
    s.store.set({ name: 'b', workspaceId: 'ws1', spec: { transport: 'http', url: 'https://b.test/mcp', headers: [], auth: 'none' }, enabled: false }, person)
    s.store.set({ name: 'c', workspaceId: 'other', spec: stdio }, person)
    s.store.setStatus(a.id, { state: 'needs-grant', tools: 0, detail: 'Needs values for FAKE_TOKEN', at: 1 })
    const [json, tail] = appAddonList(s.deps, s.root, 'claude').split('\n')
    expect(tail).toBe('Find them with tool search.')
    expect(JSON.parse(json!).addons).toEqual([
      { name: 'a', where: 'Every workspace', runs: 'npx -y fake', state: 'needs-grant', tools: 0, detail: 'Needs values for FAKE_TOKEN' },
      { name: 'b', where: 'temp-code', runs: 'https://b.test/mcp', state: 'off', tools: 0 }
    ])
    expect(appAddonList(s.deps, s.root, 'bridge').split('\n')[1]).toBe('addon_find lists them and addon_call runs one.')
  })
})

describe('addon_find', () => {
  it('ranks name words first, caps at ten, filters by add-on and lists every add-on without a query', () => {
    const s = setup()
    const gh = s.store.set({ name: 'gh', workspaceId: null, spec: stdio }, person)
    const docs = s.store.set({ name: 'docs', workspaceId: null, spec: stdio }, person)
    s.ready(gh.id, [tool('gh', 'create_issue', 'Open an issue'), tool('gh', 'search', 'Search issues and pull requests'), ...Array.from({ length: 12 }, (_, i) => tool('gh', `issue_${i}`, 'x'))])
    s.ready(docs.id, [tool('docs', 'read', 'Read an issue tracker page')])
    const find = (args: { query?: string; addon?: string }) => JSON.parse(appAddonFind(s.deps, s.root, args))
    const hits = find({ query: 'issue' }) as { tool: string }[]
    expect(hits).toHaveLength(10)
    expect(hits[0]!.tool).toBe('gh__create_issue')
    expect(hits.some((h) => h.tool === 'docs__read')).toBe(false)
    expect(find({ query: 'search issues' }).map((h: { tool: string }) => h.tool)).toEqual(['gh__search'])
    expect(find({ query: 'tracker', addon: 'docs' })).toEqual([{ tool: 'docs__read', description: 'Read an issue tracker page', inputSchema: { type: 'object', properties: {} } }])
    expect(find({})).toEqual([
      { addon: 'docs', state: 'ready', tools: ['docs__read'] },
      { addon: 'gh', state: 'ready', tools: expect.arrayContaining(['gh__create_issue', 'gh__search']) }
    ])
  })
})

describe('addon_call', () => {
  const run = async (permission: SessionMeta['permission'], readOnly: boolean, allow = true) => {
    const s = setup({ permission, allow })
    const row = s.store.set({ name: 'fake', workspaceId: null, spec: stdio }, person)
    s.ready(row.id, [tool('fake', 'echo', 'Echo', readOnly)])
    const result = await appAddonCall(s.deps, s.root, { tool: 'fake__echo', arguments: { text: 'hi' } })
    return { result, cards: s.cards, hostCalls: s.hostCalls }
  }

  it('follows the permission: auto runs, edits runs a read-only tool and asks for any other, safe always asks', async () => {
    expect((await run('auto', false)).cards).toEqual([])
    expect((await run('edits', true)).cards).toEqual([])
    expect((await run('edits', false)).cards).toEqual([{ toolName: 'fake__echo', title: 'Use echo from fake', input: { text: 'hi' } }])
    const safe = await run('safe', true)
    expect(safe.cards).toHaveLength(1)
    expect(safe.result).toEqual({ content: [{ type: 'text', text: 'done' }], structuredContent: { ok: true } })
    expect(safe.hostCalls).toEqual([{ addonId: expect.any(String), tool: 'echo', args: { text: 'hi' } }])
  })

  it('a deny, an unknown tool and an add-on not ready answer isError', async () => {
    const denied = await run('safe', false, false)
    expect(denied.result).toEqual({ content: [{ type: 'text', text: 'The person did not allow it' }], isError: true })
    expect(denied.hostCalls).toEqual([])
    const s = setup()
    const row = s.store.set({ name: 'fake', workspaceId: null, spec: stdio }, person)
    s.store.setStatus(row.id, { state: 'failed', tools: 0, detail: 'Exited (code 3): boom', at: 1 })
    expect(await appAddonCall(s.deps, s.root, { tool: 'fake__echo' })).toEqual({ content: [{ type: 'text', text: 'fake is failed: Exited (code 3): boom' }], isError: true })
    expect(await appAddonCall(s.deps, s.root, { tool: 'nope__echo' })).toEqual({ content: [{ type: 'text', text: 'No add-on tool nope__echo; addon_find lists them' }], isError: true })
  })
})
