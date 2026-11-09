import { DatabaseSync } from 'node:sqlite'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { AddonSpec, AddonTool } from '@shared/contract-addons'
import type { SessionMeta } from '@shared/events'
import { AddonStore } from '../addonStore'
import { AddonExposure, deferredTool, inputSchemaOf, type McpServerLike } from './exposure'

const spec: AddonSpec = { transport: 'stdio', command: 'x', args: [], env: [], auth: 'none' }
const person = { kind: 'person' as const }
const SCHEMA = { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { text: { type: 'string', description: 'What to echo' }, n: { type: 'integer', minimum: 1 } }, required: ['text'], additionalProperties: false }
const echo = (exposed: string, description = 'Echo'): AddonTool => ({ name: 'echo', exposed, description, inputSchema: SCHEMA })

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const clients: Client[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()))
})

/** The app server a claude thread gets: alwaysLoad, one tool of its own, one deferred management tool; a real client on it. */
async function appServer() {
  const server = createSdkMcpServer({
    name: 'app',
    version: '0.1.0',
    alwaysLoad: true,
    tools: [
      tool('app_ping', 'ping', {}, async () => ({ content: [{ type: 'text', text: 'pong' }] })),
      deferredTool(tool('addon_list', 'list', {}, async () => ({ content: [{ type: 'text', text: '[]' }] })))
    ]
  })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '1' })
  let changes = 0
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => void changes++)
  await server.instance.connect(a)
  await client.connect(b)
  clients.push(client)
  return { instance: server.instance as unknown as McpServerLike, client, changes: () => changes }
}

function setup() {
  const store = new AddonStore(new DatabaseSync(':memory:'))
  const listeners = new Set<(id: string) => void>()
  const calls: { addonId: string; tool: string; args: Record<string, unknown>; signal?: AbortSignal }[] = []
  let answer: (call: (typeof calls)[number]) => Promise<{ content: unknown[]; isError?: boolean }> = async (c) => ({ content: [{ type: 'text', text: `${c.addonId}:${JSON.stringify(c.args)}` }] })
  const workspace = new Map<string, string | null>()
  const exposure = new AddonExposure({
    store,
    host: { onChange: (fn) => (listeners.add(fn), () => listeners.delete(fn)) },
    workspaceOf: (id) => workspace.get(id) ?? null,
    call: (addonId, tool, args, opts) => {
      const c = { addonId, tool, args, signal: opts.signal }
      calls.push(c)
      return answer(c)
    }
  })
  const ready = (id: string, tools: AddonTool[]) => {
    store.setTools(id, tools)
    store.setStatus(id, { state: 'ready', tools: tools.length, at: Date.now() })
    for (const fn of listeners) fn(id)
  }
  const state = (id: string, s: 'failed' | 'starting') => {
    store.setStatus(id, { state: s, tools: 0, at: Date.now() })
    for (const fn of listeners) fn(id)
  }
  return { store, exposure, calls, workspace, ready, state, setAnswer: (fn: typeof answer) => (answer = fn) }
}

const session = (id: string): SessionMeta => ({ id }) as SessionMeta
const names = async (client: Client) => (await client.listTools()).tools.map((t) => t.name).sort()

describe('AddonExposure', () => {
  it('the app\'s own tools are always loaded, a management tool and the add-on tools are not, and the schema lists verbatim', async () => {
    const s = setup()
    const row = s.store.set({ name: 'fake', workspaceId: null, spec, description: 'A fake add-on' }, person)
    s.ready(row.id, [echo('fake__echo')])
    const app = await appServer()
    s.exposure.attach(session('t1'), app.instance)
    const tools = (await app.client.listTools()).tools
    const meta = (name: string) => tools.find((t) => t.name === name)?._meta ?? {}
    expect(meta('app_ping')['anthropic/alwaysLoad']).toBe(true)
    expect(meta('addon_list')['anthropic/alwaysLoad']).toBe(false)
    expect(meta('fake__echo')['anthropic/alwaysLoad']).toBeUndefined()
    expect(meta('fake__echo')['anthropic/searchHint']).toBe('A fake add-on')
    // The SDK writes its own `$schema`; everything else is the downstream's.
    const { $schema: _a, ...downstream } = SCHEMA
    const { $schema: _b, ...listed } = tools.find((t) => t.name === 'fake__echo')!.inputSchema as Record<string, unknown>
    expect(listed).toEqual(downstream)
  })

  it('registers and removes live, each with list_changed, and passes raw arguments and results through', async () => {
    const s = setup()
    const row = s.store.set({ name: 'fake', workspaceId: null, spec }, person)
    const app = await appServer()
    s.exposure.attach(session('t1'), app.instance)
    expect(await names(app.client)).toEqual(['addon_list', 'app_ping'])
    s.ready(row.id, [echo('fake__echo')])
    await until(() => app.changes() >= 1)
    expect(await names(app.client)).toEqual(['addon_list', 'app_ping', 'fake__echo'])
    expect(s.exposure.listed('t1').get('fake__echo')).toEqual({ addonId: row.id, tool: 'echo' })
    s.setAnswer(async () => ({ content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }], isError: true }))
    const result = await app.client.callTool({ name: 'fake__echo', arguments: { text: 'hi', extra: [1, 2] } })
    expect(s.calls.at(-1)!.args).toEqual({ text: 'hi', extra: [1, 2] })
    expect(result).toMatchObject({ content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }], isError: true })
    const before = app.changes()
    s.state(row.id, 'failed')
    await until(() => app.changes() > before)
    expect(await names(app.client)).toEqual(['addon_list', 'app_ping'])
  })

  it('a workspace row shadows the global one even with identical tools, and the global one comes back when it goes', async () => {
    const s = setup()
    s.workspace.set('t1', 'ws1')
    const global = s.store.set({ name: 'gh', workspaceId: null, spec }, person)
    s.ready(global.id, [echo('gh__echo')])
    const app = await appServer()
    s.exposure.attach(session('t1'), app.instance)
    await app.client.callTool({ name: 'gh__echo', arguments: { text: 'a' } })
    expect(s.calls.at(-1)!.addonId).toBe(global.id)
    const local = s.store.set({ name: 'gh', workspaceId: 'ws1', spec }, person)
    s.ready(local.id, [echo('gh__echo')])
    await app.client.callTool({ name: 'gh__echo', arguments: { text: 'b' } })
    expect(s.calls.at(-1)!.addonId).toBe(local.id)
    s.store.remove(local.id)
    await app.client.callTool({ name: 'gh__echo', arguments: { text: 'c' } })
    expect(s.calls.at(-1)!.addonId).toBe(global.id)
  })

  it('a release after a newer attach leaves the newer one updating', async () => {
    const s = setup()
    const row = s.store.set({ name: 'fake', workspaceId: null, spec }, person)
    const first = await appServer()
    const second = await appServer()
    const releaseFirst = s.exposure.attach(session('t1'), first.instance)
    s.exposure.attach(session('t1'), second.instance)
    releaseFirst()
    s.ready(row.id, [echo('fake__echo')])
    await until(() => second.changes() >= 1)
    expect(await names(second.client)).toContain('fake__echo')
    expect(await names(first.client)).not.toContain('fake__echo')
  })

  it('a cancelled request aborts the downstream call\'s signal', async () => {
    const s = setup()
    const row = s.store.set({ name: 'fake', workspaceId: null, spec }, person)
    s.ready(row.id, [echo('fake__echo')])
    let aborted = false
    s.setAnswer(
      (c) =>
        new Promise((resolve) => {
          c.signal?.addEventListener('abort', () => {
            aborted = true
            resolve({ content: [] })
          })
        })
    )
    const app = await appServer()
    s.exposure.attach(session('t1'), app.instance)
    const abort = new AbortController()
    const pending = app.client.callTool({ name: 'fake__echo', arguments: { text: 'x' } }, undefined, { signal: abort.signal }).catch(() => 'cancelled')
    await until(() => s.calls.length === 1)
    abort.abort()
    expect(await pending).toBe('cancelled')
    await until(() => aborted)
  })

  it('inputSchemaOf gives a schema without a type one', () => {
    expect(z.toJSONSchema(inputSchemaOf({ properties: { a: { type: 'string' } } }))).toMatchObject({ type: 'object', properties: { a: { type: 'string' } } })
  })
})
