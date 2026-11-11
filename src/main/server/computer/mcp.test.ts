import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'
import { COMPUTER_ACTION_NAMES } from '@shared/computer/protocol'
import { COMPUTER_BRIDGE_NOTE, COMPUTER_SEARCH_HINT, COMPUTER_TOOLS, computerToolJsonSchema, computerToolSpecs } from '@shared/computer/tools'
import type { SessionMeta } from '@shared/events'
import { APP_TOOLS } from '../apptools'
import { MacThreadTokens } from '../macTools'
import type { ComputerBridge } from './bridge'
import { COMPUTER_APP_TOOLS, computerToolList, computerTools, type ComputerHost } from './mcp'
import { setComputerWordsOverride } from './prompts'
import { computerHarness, type ComputerHarness } from './runHarness'

const session = { id: 't1', permission: 'auto', provider: 'claude', model: 'claude-opus-5-5' } as unknown as SessionMeta
const harnesses: ComputerHarness[] = []
const clients: Client[] = []
afterEach(async () => {
  setComputerWordsOverride(null)
  await Promise.all(clients.splice(0).map((c) => c.close()))
  for (const h of harnesses.splice(0)) await h.close()
})

function hostOf(h: ComputerHarness, available = true): ComputerHost {
  return { available: () => available, sessions: h.sessions, service: h.service, tokens: new MacThreadTokens(null, 'computer') }
}

async function connect(host: ComputerHost | null, bridge: ComputerBridge | null = null, meta: SessionMeta = session) {
  const server = createSdkMcpServer({ name: 'app', version: '0.1.0', alwaysLoad: true, tools: computerTools(meta, host, bridge) })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '1' })
  await server.instance.connect(a)
  await client.connect(b)
  clients.push(client)
  return client
}

describe('computerTools', () => {
  it('is empty where computer use is unavailable', () => {
    const h = computerHarness()
    harnesses.push(h)
    expect(computerTools(session, hostOf(h, false))).toEqual([])
    expect(computerTools(session, null)).toEqual([])
  })

  it('lists the four, deferred with the search hint, with the schemas tools.ts gives', async () => {
    const h = computerHarness()
    harnesses.push(h)
    const { tools } = await (await connect(hostOf(h))).listTools()
    expect(tools.map((t) => t.name)).toEqual(COMPUTER_TOOLS.map((t) => t.name))
    for (const t of tools) {
      expect(t._meta?.['anthropic/alwaysLoad']).toBe(false)
      expect(t._meta?.['anthropic/searchHint']).toBe(COMPUTER_SEARCH_HINT)
      const want = computerToolJsonSchema(COMPUTER_TOOLS.find((s) => s.name === t.name)!.input) as { properties: Record<string, unknown>; required?: string[] }
      expect(Object.keys(t.inputSchema.properties ?? {}).sort()).toEqual(Object.keys(want.properties).sort())
      expect([...(t.inputSchema.required ?? [])].sort()).toEqual([...(want.required ?? [])].sort())
    }
  })

  it('a call runs the flow, refusals included, and pictures come back as image parts in order', async () => {
    const h = computerHarness()
    harnesses.push(h)
    const client = await connect(hostOf(h))
    const refused = (await client.callTool({ name: 'computer_act', arguments: { app: 'TextEdit', action: 'mouse_move' } })) as { content: { type: string; text?: string }[]; isError?: boolean }
    expect(refused.isError).toBe(true)
    expect(refused.content[0].text).toMatch(/^invalid arguments: element: mouse_move needs one of element, coordinate/)
    const shot = (await client.callTool({
      name: 'computer_batch',
      arguments: { app: 'TextEdit', screenshot: true, actions: [{ action: 'screenshot' }] }
    })) as { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean }
    expect(shot.isError).toBe(false)
    expect(shot.content.map((c) => c.type)).toEqual(['text', 'image', 'image'])
    expect(shot.content[0].text).toMatch(/^screenshot\nscreenshot 1 \(step 1\): .*0001\.jpg/)
    expect(Buffer.from(shot.content[1].data!, 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    expect(shot.content[1].mimeType).toBe('image/jpeg')
  })

  it('APP_TOOLS lists every name either tool shape gives, so the CLI never asks a second time', () => {
    expect(COMPUTER_APP_TOOLS.slice(0, 4)).toEqual(['mcp__app__computer_apps', 'mcp__app__computer_observe', 'mcp__app__computer_act', 'mcp__app__computer_batch'])
    expect(COMPUTER_APP_TOOLS.slice(4)).toEqual(COMPUTER_ACTION_NAMES.map((a) => `mcp__app__computer_${a}`))
    for (const name of COMPUTER_APP_TOOLS) expect(APP_TOOLS).toContain(name)
  })

  it("gives each thread its model's words, and the per-verb set under the comparison's override", async () => {
    const h = computerHarness()
    harnesses.push(h)
    const opus = await (await connect(hostOf(h))).listTools()
    expect(opus.tools.find((t) => t.name === 'computer_observe')!.description).toBe(computerToolSpecs('cua', 'act')[1].description)
    expect(computerToolList({ provider: 'codex', model: 'gpt-6.1-sol' }).find((t) => t.name === 'computer_observe')!.description).toContain('getAXState')
    expect(computerToolList({ provider: 'muse', model: 'muse-wonder-1.0' }).find((t) => t.name === 'computer_observe')!.description).not.toContain('getAXState')
    setComputerWordsOverride({ shape: 'anthropic', tools: 'per-verb' })
    const perVerb = await (await connect(hostOf(h))).listTools()
    expect(perVerb.tools.map((t) => t.name)).toEqual(computerToolSpecs('anthropic', 'per-verb').map((t) => t.name))
    const clicked = (await (await connect(hostOf(h))).callTool({ name: 'computer_left_click', arguments: { app: 'TextEdit', coordinate: [5, 5] } })) as { isError?: boolean; content: { text?: string }[] }
    expect(clicked.isError).toBe(false)
    expect(clicked.content[0].text).toMatch(/^left_click 5,5 · /)
  })
})

describe('computerTools on a box thread bridged to its Mac', () => {
  const stubBridge = (offered: boolean) => {
    const runs: { threadId: string; tool: string; args: unknown }[] = []
    const bridge = {
      offered: () => offered,
      run: async (ctx: { threadId: string }, tool: string, args: unknown) => {
        runs.push({ threadId: ctx.threadId, tool, args })
        return { steps: ['set_value [3] · ax · changed'], shots: [], body: 'TextEdit "Untitled"', isError: false }
      }
    } as unknown as ComputerBridge
    return { bridge, runs }
  }

  it('lists the four with the bridge note when the Mac offers computer use, none when it does not', async () => {
    expect(computerTools(session, null, stubBridge(false).bridge)).toEqual([])
    const { tools } = await (await connect(null, stubBridge(true).bridge)).listTools()
    expect(tools.map((t) => t.name)).toEqual(COMPUTER_TOOLS.map((t) => t.name))
    for (const t of tools) expect(t.description?.endsWith(COMPUTER_BRIDGE_NOTE)).toBe(true)
    expect(computerToolList(session, { bridged: true }).every((t) => t.description.endsWith(COMPUTER_BRIDGE_NOTE))).toBe(true)
    expect(computerToolList(session).some((t) => t.description.endsWith(COMPUTER_BRIDGE_NOTE))).toBe(false)
  })

  it('the bridge lists computer_result fifth in both tool shapes when asked, and Claude never gets it', async () => {
    for (const meta of [{ provider: 'codex', model: 'gpt-6.1-sol' }, { provider: 'muse', model: 'muse-wonder-1.0' }] as const) {
      for (const words of [null, { shape: 'anthropic', tools: 'act' }, { shape: 'cua', tools: 'act' }, { shape: 'anthropic', tools: 'per-verb' }, { shape: 'cua', tools: 'per-verb' }] as const) {
        setComputerWordsOverride(words)
        const four = computerToolList(meta, { bridged: true }).map((t) => t.name)
        const five = computerToolList(meta, { bridged: true, result: true })
        expect(four).not.toContain('computer_result')
        expect(five.map((t) => t.name)).toEqual([...four, 'computer_result'])
        expect(five.at(-1)!.description.endsWith(COMPUTER_BRIDGE_NOTE)).toBe(true)
        expect(five.at(-1)!.inputSchema.required).toEqual(['id'])
        if (words?.tools === 'act') expect([four.length, five.length]).toEqual([4, 5])
      }
    }
    setComputerWordsOverride(null)
    expect(computerToolList({ provider: 'codex', model: 'gpt-6.1-sol' }, { result: true })).toHaveLength(5)
    expect(computerToolList({ provider: 'codex', model: 'gpt-6.1-sol' })).toHaveLength(4)
    const { tools } = await (await connect(null, stubBridge(true).bridge)).listTools()
    expect(tools.map((t) => t.name)).not.toContain('computer_result')
  })

  it('a call goes to the bridge, never to a host that is not available', async () => {
    const h = computerHarness()
    harnesses.push(h)
    const { bridge, runs } = stubBridge(true)
    const client = await connect(hostOf(h, false), bridge)
    const out = (await client.callTool({ name: 'computer_act', arguments: { app: 'TextEdit', action: 'set_value', element: 3, value: 'x' } })) as { content: { type: string; text?: string }[] }
    expect(runs).toEqual([{ threadId: 't1', tool: 'computer_act', args: expect.objectContaining({ app: 'TextEdit' }) }])
    expect(out.content[0].text).toBe('set_value [3] · ax · changed\n\nTextEdit "Untitled"')
    expect(h.requests()).toEqual([])
  })
})
