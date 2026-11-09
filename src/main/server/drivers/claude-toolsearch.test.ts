import { afterEach, expect, it, vi } from 'vitest'
import { query, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { SessionMeta } from '@shared/events'
import type { DriverHandle } from './types'

vi.mock('electron', () => ({ nativeImage: {} }))
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: vi.fn()
}))
vi.mock('./binaries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./binaries')>()),
  resolveClaude: async () => ({ path: null })
}))
vi.mock('../endpoint', () => ({ routedEndpointFor: async () => ({ url: null }) }))

const { claudeDriver } = await import('./claude')
const { setAppAddons } = await import('../apptools')
const { orchestratorMcp } = await import('../orchestration')
const { macToolsMcp } = await import('../macTools')

/**
 * Tool search is on for every claude thread (the CLI turns it off for our
 * base URL otherwise), and the app's own servers keep their tools in every
 * prompt while the add-on tools and the add-on management tools are found by
 * search (plan-L1Vrd-CMiZJ7.md section 5).
 */

const handles: DriverHandle[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.dispose()
  setAppAddons(null)
})

const session = (over: Partial<SessionMeta> = {}): SessionMeta =>
  ({ id: 'ts-1', provider: 'claude', cwd: '/repo', model: 'claude-opus-5-5', reasoning: 'high', permission: 'safe', context1m: false, nativeId: null, ...over }) as SessionMeta

async function start(over: Partial<SessionMeta> = {}) {
  vi.mocked(query).mockImplementation(({ prompt }) => (async function* () {
    if (typeof prompt !== 'string') for await (const _message of prompt) { /* No CLI output. */ }
  })() as ReturnType<typeof query>)
  const handle = await claudeDriver.start({ session: session(over), emit: () => {}, setNativeId: () => {}, requestApproval: async () => false })
  handles.push(handle)
  return { handle, options: vi.mocked(query).mock.calls.at(-1)![0].options! }
}

/** Each tool's `anthropic/alwaysLoad` as a client lists the server. */
async function loads(server: McpSdkServerConfigWithInstance): Promise<Record<string, unknown>> {
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '1' })
  await server.instance.connect(a)
  await client.connect(b)
  const { tools } = await client.listTools()
  await client.close()
  return Object.fromEntries(tools.map((t) => [t.name, t._meta?.['anthropic/alwaysLoad']]))
}

it('every claude spawn turns tool search on', async () => {
  const { options } = await start()
  expect(options.env?.ENABLE_TOOL_SEARCH).toBe('true')
  const { options: orchestrator } = await start({ id: 'ts-2', agentType: 'orchestrator' })
  expect(orchestrator.env?.ENABLE_TOOL_SEARCH).toBe('true')
})

it("the app's own tools are always loaded; the add-on management and skill tools are deferred", async () => {
  const { options } = await start()
  const app = await loads(options.mcpServers!.app as McpSdkServerConfigWithInstance)
  expect(app.app_list_threads).toBe(true)
  expect(app.merge_branch).toBe(true)
  expect(app.addon_list).toBe(false)
  expect(app.addon_add).toBe(false)
  expect(app.addon_remove).toBe(false)
  expect(app.skill_list).toBe(false)
  expect(app.skill_write).toBe(false)
  expect(app.skill_remove).toBe(false)
})

it('the orchestrator and Mac servers list every tool always loaded', async () => {
  for (const server of [orchestratorMcp(session({ agentType: 'orchestrator' })), macToolsMcp(session(), '/Users/me')]) {
    const all = await loads(server)
    expect(Object.keys(all).length).toBeGreaterThan(0)
    expect(Object.values(all).every((v) => v === true)).toBe(true)
  }
})

it('the thread\'s add-on tools attach to its app server and are released when the handle ends', async () => {
  const attached: string[] = []
  const released: string[] = []
  setAppAddons({
    exposure: {
      attach: (s) => {
        attached.push(s.id)
        return () => released.push(s.id)
      }
    },
    list: () => '[]',
    add: async () => 'ok',
    remove: async () => 'ok',
    hasAddons: () => false
  })
  const { handle } = await start({ id: 'ts-attach' })
  expect(attached).toEqual(['ts-attach'])
  expect(released).toEqual([])
  await handle.dispose()
  expect(released).toEqual(['ts-attach'])
})
