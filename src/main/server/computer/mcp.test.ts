import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'
import { COMPUTER_SEARCH_HINT, COMPUTER_TOOLS, computerToolJsonSchema } from '@shared/computer/tools'
import type { SessionMeta } from '@shared/events'
import { APP_TOOLS } from '../apptools'
import { MacThreadTokens } from '../macTools'
import { COMPUTER_APP_TOOLS, computerTools, type ComputerHost } from './mcp'
import { computerHarness, type ComputerHarness } from './runHarness'

const session = { id: 't1', permission: 'auto' } as unknown as SessionMeta
const harnesses: ComputerHarness[] = []
const clients: Client[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()))
  for (const h of harnesses.splice(0)) await h.close()
})

function hostOf(h: ComputerHarness, available = true): ComputerHost {
  return { available: () => available, sessions: h.sessions, service: h.service, tokens: new MacThreadTokens(null, 'computer') }
}

async function connect(host: ComputerHost) {
  const server = createSdkMcpServer({ name: 'app', version: '0.1.0', alwaysLoad: true, tools: computerTools(session, host) })
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

  it('APP_TOOLS lists the four, so the CLI never asks a second time', () => {
    expect(COMPUTER_APP_TOOLS).toEqual(['mcp__app__computer_apps', 'mcp__app__computer_observe', 'mcp__app__computer_act', 'mcp__app__computer_batch'])
    for (const name of COMPUTER_APP_TOOLS) expect(APP_TOOLS).toContain(name)
  })
})
