import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { WebSocket, WebSocketServer } from 'ws'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  HTML_PREVIEW_TOOL_DESCRIPTION,
  HTML_RENDER_TOOL_DESCRIPTION,
  HTML_TOOL_PARAMS
} from '@shared/htmlRender'
import { CITE_TOOL_DESCRIPTION, CITE_TOOL_PARAMS } from '@shared/research'
import { NOTES_STREAK_STOP, UPDATE_NOTES_DESCRIPTION, UPDATE_NOTES_PARAMS, UPDATE_NOTES_TOOL_NAME } from '@shared/notes'
import { ThreadTypeSchema } from '@shared/domain'
import { NOTE_DECISION_DESCRIPTION, NOTE_DECISION_PARAMS, NOTE_DECISION_TOOL_NAME } from '@shared/away'
import {
  ADOPT_THREAD_PARAMS,
  ADOPT_THREAD_TOOL_DESCRIPTION,
  ADOPT_THREAD_TOOL_NAME,
  ARCHIVE_THREADS_PARAMS,
  ARCHIVE_THREADS_TOOL_DESCRIPTION,
  ARCHIVE_THREADS_TOOL_NAME,
  BATCH_GATE_PARAMS,
  BATCH_GATE_TOOL_DESCRIPTION,
  BATCH_GATE_TOOL_NAME,
  BATCH_RULES_PARAMS,
  BATCH_RULES_TOOL_DESCRIPTION,
  BATCH_RULES_TOOL_NAME
} from '@shared/gate'
import { NOTE_DECISION_SHAPE, SKILL_REMOVE_SHAPE, SKILL_WRITE_SHAPE, ADOPT_THREAD_SHAPE, ARCHIVE_THREADS_SHAPE, BATCH_GATE_SHAPE, BATCH_RULES_SHAPE, CITE_SHAPE, HTML_PREVIEW_SHAPE, HTML_RENDER_SHAPE, MERGE_BRANCH_SHAPE, REPORT_FINDINGS_SHAPE } from './apptools'
import * as addons from '@shared/addons'
import { bridgeMcpConfig, setAppAddons, setAppBridge } from './apptools'
import { computerBridgeHooks, type ComputerBridge } from './computer/bridge'
import { MacThreadTokens } from './macTools'
import {
  MERGE_BRANCH_PARAMS,
  MERGE_BRANCH_TOOL_DESCRIPTION,
  REPORT_FINDINGS_PARAMS,
  REPORT_FINDINGS_TOOL_DESCRIPTION,
  REVIEW_FINDING_PARAMS
} from '@shared/review'
import {
  SKILL_LIST_DESCRIPTION,
  SKILL_LIST_TOOL,
  SKILL_REMOVE_DESCRIPTION,
  SKILL_REMOVE_PARAMS,
  SKILL_REMOVE_TOOL,
  SKILL_WRITE_DESCRIPTION,
  SKILL_WRITE_PARAMS,
  SKILL_WRITE_TOOL
} from '@shared/skills'

const bridgePath = join(import.meta.dirname, '..', '..', '..', 'scripts', 'app-mcp-bridge.mjs')

type BridgeTool = {
  name: string
  description: string
  inputSchema: {
    properties: Record<string, { description?: string }>
    required?: string[]
  }
}

const bridge = (await import(bridgePath)) as {
  TOOLS: BridgeTool[]
  METHOD_FOR: Record<string, string>
  clientTimeoutMs: (name: string, args?: unknown) => number
  toolContent: (name: string, result: unknown) => Array<Record<string, unknown>>
}

describe('app-mcp-bridge cite_source and thread types', () => {
  it("the bridge's cite_source matches the shared description and params", () => {
    const cite = bridge.TOOLS.find((t) => t.name === 'cite_source')!
    expect(cite.description).toBe(CITE_TOOL_DESCRIPTION)
    expect(Object.keys(cite.inputSchema.properties)).toEqual(Object.keys(CITE_SHAPE))
    expect(cite.inputSchema.required).toEqual(['url', 'claim'])
    for (const [name, schema] of Object.entries(cite.inputSchema.properties)) {
      expect(schema.description).toBe(CITE_TOOL_PARAMS[name as keyof typeof CITE_TOOL_PARAMS])
    }
  })

  it('the bridge lists plan_complete for planning and project-plan threads', () => {
    const tool = bridge.TOOLS.find((t) => t.name === 'plan_complete')!
    expect(tool).toBeDefined()
    expect(Object.keys(tool.inputSchema.properties)).toEqual(['summary'])
    expect(tool.description).toContain('project plan gets `status: complete`')
  })

  it('app_start_thread offers every thread type, research included', () => {
    const start = bridge.TOOLS.find((t) => t.name === 'app_start_thread')!
    const threadType = start.inputSchema.properties.threadType as { enum?: string[] }
    expect(threadType.enum).toEqual(ThreadTypeSchema.options)
  })
})

describe('app-mcp-bridge computer tools over stdio', () => {
  type RpcRequest = { id: string; method: string; params: Record<string, unknown> }
  type McpReply = {
    id: string | number
    result: { tools: BridgeTool[]; content: Array<Record<string, unknown>>; isError?: boolean }
  }

  async function startBridge(
    answer: (request: RpcRequest, ws: WebSocket) => void,
    env: Record<string, string | undefined> = {},
    shortenDeadline = false
  ) {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(server, 'listening')
    const requests: RpcRequest[] = []
    server.on('connection', (ws) => {
      ws.on('message', (data) => {
        const request = JSON.parse(String(data)) as RpcRequest
        requests.push(request)
        answer(request, ws)
      })
    })
    // Make an accidental default deadline expire before the fake app answers,
    // without spending two minutes on the no-deadline regression test.
    const preload = `const original = globalThis.setTimeout;
      globalThis.setTimeout = (fn, ms, ...args) => original(fn, ms === 120000 ? 20 : ms, ...args);`
    const child = spawn(process.execPath, [
      ...(shortenDeadline ? ['--import', `data:text/javascript,${encodeURIComponent(preload)}`] : []),
      bridgePath
    ], {
      env: {
        ...process.env,
        TEMP_CODE_PORT: String((server.address() as { port: number }).port),
        TEMP_CODE_SESSION: 'computer-thread',
        TEMP_CODE_COMPUTER_TOKEN: undefined,
        TEMP_CODE_COMPUTER_IMAGES: undefined,
        TEMP_CODE_MAC_TOKEN: '',
        TEMP_CODE_ADDONS: '',
        ...env
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stderr = ''
    child.stderr.on('data', (data) => { stderr += String(data) })
    const replies = new Map<string | number, (reply: McpReply) => void>()
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      const reply = JSON.parse(line) as McpReply
      replies.get(reply.id)?.(reply)
      replies.delete(reply.id)
    })
    onTestFinished(async () => {
      const exited = once(child, 'exit')
      child.kill()
      await exited
      lines.close()
      for (const ws of server.clients) ws.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    const notify = (method: string, params: Record<string, unknown>) => {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
    }
    const request = (id: string | number, method: string, params: Record<string, unknown> = {}) =>
      new Promise<McpReply>((resolve) => {
        replies.set(id, resolve)
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      })
    return { request, notify, requests, stderr: () => stderr }
  }

  const reply = (ws: WebSocket, request: RpcRequest, result: unknown) =>
    ws.send(JSON.stringify({ id: request.id, ok: true, result }))
  const computerNames = (response: McpReply) => response.result.tools.filter((t) => t.name.startsWith('computer_'))
  const tokenEnv = { TEMP_CODE_COMPUTER_TOKEN: 'thread-token' }

  it("returns update_notes' streak refusal verbatim", async () => {
    const app = await startBridge((request, ws) => reply(ws, request, NOTES_STREAK_STOP))
    const answer = await app.request(1, 'tools/call', { name: 'update_notes', arguments: { section: 'State', content: 'x' } })
    expect(app.requests.map((r) => r.method)).toEqual(['app.updateNotes'])
    expect(answer.result.content).toEqual([{ type: 'text', text: NOTES_STREAK_STOP }])
  })

  it('neither lists nor calls computer tools without the token', async () => {
    const app = await startBridge((request, ws) => reply(ws, request, 'threads'))
    expect(computerNames(await app.request(1, 'tools/list'))).toEqual([])
    const denied = await app.request(2, 'tools/call', { name: 'computer_act', arguments: {} })
    expect(denied.result.isError).toBe(true)
    app.notify('notifications/cancelled', { requestId: 2 })
    await app.request(3, 'tools/call', { name: 'app_list_threads' })
    expect(app.requests.map((r) => r.method)).toEqual(['app.listThreads'])
  })

  it('copies the app tool list exactly and fetches it once across concurrent lists', async () => {
    const tools = ['computer_apps', 'computer_observe', 'computer_act', 'computer_batch'].map((name) => ({
      name,
      description: `Server description for ${name}`,
      inputSchema: { type: 'object', properties: { custom: { type: 'string', enum: ['server-value'] } }, required: ['custom'] }
    }))
    const app = await startBridge((request, ws) => {
      setTimeout(() => reply(ws, request, { tools }), 30)
    }, tokenEnv)
    const lists = await Promise.all([app.request(1, 'tools/list'), app.request(2, 'tools/list')])
    for (const list of lists) expect(computerNames(list)).toEqual(tools)
    expect(app.requests).toHaveLength(1)
    expect(app.requests[0]).toMatchObject({
      method: 'app.computerTools', params: { sessionId: 'computer-thread', token: 'thread-token' }
    })
  })

  it('forwards the MCP id, token and parts setting, then returns text, ordered images and isError', async () => {
    const app = await startBridge((request, ws) => reply(ws, request, {
      text: 'The action failed',
      isError: true,
      images: [
        { label: 'step 1', data: 'Zmlyc3Q=', mimeType: 'image/png', width: 10, height: 20 },
        { label: 'step 2', data: 'c2Vjb25k', mimeType: 'image/jpeg', width: 30, height: 40 }
      ]
    }), { ...tokenEnv, TEMP_CODE_COMPUTER_IMAGES: 'parts' })
    const args = { app: 'Notes', action: 'left_click', coordinate: [10, 20] }
    const response = await app.request('act-1', 'tools/call', { name: 'computer_act', arguments: args })
    expect(app.requests[0]).toMatchObject({
      method: 'app.computer',
      params: { sessionId: 'computer-thread', call: 'act-1', tool: 'computer_act', args, token: 'thread-token', images: 'parts' }
    })
    expect(response.result).toEqual({
      content: [
        { type: 'text', text: 'The action failed' },
        { type: 'image', data: 'Zmlyc3Q=', mimeType: 'image/png' },
        { type: 'image', data: 'c2Vjb25k', mimeType: 'image/jpeg' }
      ],
      isError: true
    })
  })

  it.each([undefined, 'none', 'invalid'])('uses images none for the setting %j and defaults missing arguments', async (images) => {
    const app = await startBridge((request, ws) => reply(ws, request, {
      text: 'done', images: [], isError: false
    }), { ...tokenEnv, TEMP_CODE_COMPUTER_IMAGES: images })
    const response = await app.request(7, 'tools/call', { name: 'computer_act' })
    expect(app.requests[0].params).toEqual({
      sessionId: 'computer-thread', call: 7, tool: 'computer_act', args: {}, token: 'thread-token', images: 'none'
    })
    expect(response.result).toEqual({ content: [{ type: 'text', text: 'done' }], isError: false })
  })

  it('waits for a computer answer past the default client deadline', async () => {
    const app = await startBridge((request, ws) => {
      setTimeout(() => reply(ws, request, { text: 'late answer', images: [], isError: false }), 80)
    }, tokenEnv, true)
    const timedOut = await app.request(0, 'tools/call', { name: 'app_list_threads' })
    expect(timedOut.result).toEqual({
      content: [{ type: 'text', text: 'error: app server timeout' }], isError: true
    })
    const response = await app.request(1, 'tools/call', { name: 'computer_act', arguments: { app: 'Notes', action: 'key', key: 'a' } })
    expect(response.result).toEqual({ content: [{ type: 'text', text: 'late answer' }], isError: false })
  })

  it.each([42, 'call-42'])('cancels only the pending computer call %j and ignores cancel errors', async (id) => {
    let pending: { request: RpcRequest; ws: WebSocket } | undefined
    const app = await startBridge((request, ws) => {
      if (request.method === 'app.computer') pending = { request, ws }
      else if (request.method === 'app.computerCancel') {
        ws.send(JSON.stringify({ id: request.id, ok: false, error: 'already stopping' }))
        reply(pending!.ws, pending!.request, { text: 'cancelled', images: [], isError: true })
      } else reply(ws, request, 'threads')
    }, tokenEnv)
    const result = app.request(id, 'tools/call', { name: 'computer_act', arguments: {} })
    await vi.waitFor(() => expect(pending).toBeDefined())
    app.notify('notifications/cancelled', { requestId: 'unrelated' })
    app.notify('notifications/cancelled', { requestId: id })
    expect((await result).result.isError).toBe(true)
    app.notify('notifications/cancelled', { requestId: id })
    await app.request('still-serving', 'tools/call', { name: 'app_list_threads' })
    expect(app.requests.filter((r) => r.method === 'app.computerCancel')).toEqual([
      expect.objectContaining({ params: { sessionId: 'computer-thread', call: id, token: 'thread-token' } })
    ])
  })

  it("lists computer_result from the app's list and sends it as app.computer with no client deadline", async () => {
    const tools = ['computer_apps', 'computer_observe', 'computer_act', 'computer_batch', 'computer_result'].map((name) => ({
      name,
      description: `Server description for ${name}`,
      inputSchema: { type: 'object', properties: {} }
    }))
    const app = await startBridge((request, ws) => {
      if (request.method === 'app.computerTools') reply(ws, request, { tools })
      else setTimeout(() => reply(ws, request, { text: 'left_click · ax · changed', images: [], isError: false }), 80)
    }, tokenEnv, true)
    expect(computerNames(await app.request(1, 'tools/list')).map((t) => t.name)).toContain('computer_result')
    const args = { id: 'c4' }
    const response = await app.request('read-1', 'tools/call', { name: 'computer_result', arguments: args })
    expect(app.requests.find((r) => r.method === 'app.computer')).toMatchObject({
      params: { sessionId: 'computer-thread', call: 'read-1', tool: 'computer_result', args, token: 'thread-token' }
    })
    expect(response.result).toEqual({ content: [{ type: 'text', text: 'left_click · ax · changed' }], isError: false })
  })

  it('a cancel for a computer_result sends app.computerCancel with its own request id', async () => {
    const pending = new Map<unknown, { request: RpcRequest; ws: WebSocket }>()
    const app = await startBridge((request, ws) => {
      if (request.method === 'app.computer') pending.set(request.params.call, { request, ws })
      else if (request.method === 'app.computerCancel') {
        const p = pending.get(request.params.call)!
        reply(ws, request, { cancelled: true })
        reply(p.ws, p.request, { text: 'cancelled', images: [], isError: true })
      } else reply(ws, request, 'threads')
    }, tokenEnv)
    const held = app.request('act-9', 'tools/call', { name: 'computer_act', arguments: {} })
    const read = app.request('read-9', 'tools/call', { name: 'computer_result', arguments: { id: 'c1' } })
    await vi.waitFor(() => expect(pending.size).toBe(2))
    app.notify('notifications/cancelled', { requestId: 'read-9' })
    expect((await read).result.isError).toBe(true)
    expect(app.requests.filter((r) => r.method === 'app.computerCancel')).toEqual([
      expect.objectContaining({ params: { sessionId: 'computer-thread', call: 'read-9', token: 'thread-token' } })
    ])
    const act = pending.get('act-9')!
    reply(act.ws, act.request, { text: 'done', images: [], isError: false })
    expect((await held).result.isError).toBe(false)
  })

  it('logs a discovery failure once, caches the empty list and keeps serving other tools', async () => {
    const app = await startBridge((request, ws) => {
      if (request.method === 'app.computerTools') {
        ws.send(JSON.stringify({ id: request.id, ok: false, error: 'computer unavailable\ntry later' }))
      } else reply(ws, request, 'threads still work')
    }, tokenEnv)
    expect(computerNames(await app.request(1, 'tools/list'))).toEqual([])
    expect(computerNames(await app.request(2, 'tools/list'))).toEqual([])
    expect((await app.request(3, 'tools/call', { name: 'app_list_threads' })).result).toEqual({
      content: [{ type: 'text', text: 'threads still work' }]
    })
    expect(app.requests.filter((r) => r.method === 'app.computerTools')).toHaveLength(1)
    await vi.waitFor(() => expect(app.stderr()).toBe('[app-bridge] computer tools: computer unavailable try later\n'))
  })
})

describe('app-mcp-bridge update_notes', () => {
  it('carries the shared description and parameter texts', () => {
    const tool = bridge.TOOLS.find((t) => t.name === UPDATE_NOTES_TOOL_NAME)!
    expect(tool.description).toBe(UPDATE_NOTES_DESCRIPTION)
    const props = tool.inputSchema.properties as Record<string, { description?: string; enum?: string[] }>
    expect(props.section.description).toBe(UPDATE_NOTES_PARAMS.section)
    expect(props.mode.description).toBe(UPDATE_NOTES_PARAMS.mode)
    expect(props.mode.enum).toEqual(['replace', 'append'])
    expect(props.content.description).toBe(UPDATE_NOTES_PARAMS.content)
    expect(tool.inputSchema.required).toEqual(['section', 'content'])
  })
})

describe('app-mcp-bridge note_decision', () => {
  it('carries the shared description and parameter text', () => {
    const tool = bridge.TOOLS.find((t) => t.name === NOTE_DECISION_TOOL_NAME)!
    expect(tool.description).toBe(NOTE_DECISION_DESCRIPTION)
    expect(Object.keys(tool.inputSchema.properties)).toEqual(Object.keys(NOTE_DECISION_SHAPE))
    expect(tool.inputSchema.properties.decision.description).toBe(NOTE_DECISION_PARAMS.decision)
    expect(tool.inputSchema.required).toEqual(['decision'])
  })
})

describe('app-mcp-bridge html tools', () => {
  it("the bridge's descriptions equal the shared constants and its schemas name the same params", () => {
    const preview = bridge.TOOLS.find((t) => t.name === 'html_preview')!
    const render = bridge.TOOLS.find((t) => t.name === 'html_render')!
    expect(preview.description).toBe(HTML_PREVIEW_TOOL_DESCRIPTION)
    expect(render.description).toBe(HTML_RENDER_TOOL_DESCRIPTION)
    expect(Object.keys(preview.inputSchema.properties)).toEqual(Object.keys(HTML_PREVIEW_SHAPE))
    expect(Object.keys(render.inputSchema.properties)).toEqual(Object.keys(HTML_RENDER_SHAPE))
    expect(preview.inputSchema.required).toEqual(['html'])
    expect(render.inputSchema.required).toEqual(['html', 'title', 'height'])
    for (const tool of [preview, render]) {
      for (const [name, schema] of Object.entries(tool.inputSchema.properties)) {
        expect(schema.description).toBe(HTML_TOOL_PARAMS[name as keyof typeof HTML_TOOL_PARAMS])
      }
    }
  })

  it('passes the preview PNG through as an image part and everything else as text', () => {
    const parts = bridge.toolContent('html_preview', {
      png: 'UE5H',
      width: 864,
      contentHeight: 10,
      capturedHeight: 10,
      consoleMessages: []
    })
    expect(parts).toEqual([
      { type: 'text', text: JSON.stringify({ width: 864, contentHeight: 10, capturedHeight: 10, consoleMessages: [] }) },
      { type: 'image', data: 'UE5H', mimeType: 'image/png' }
    ])
    expect(bridge.toolContent('html_render', { htmlRender: { pageId: 'p' }, message: 'm' })).toEqual([
      { type: 'text', text: '{"htmlRender":{"pageId":"p"},"message":"m"}' }
    ])
    expect(bridge.toolContent('app_read_thread', 'digest')).toEqual([{ type: 'text', text: 'digest' }])
  })
})

describe('app-mcp-bridge merge_branch and report_findings', () => {
  it("the bridge's merge_branch matches the shared description and params", () => {
    const t = bridge.TOOLS.find((x) => x.name === 'merge_branch')!
    expect(t.description).toBe(MERGE_BRANCH_TOOL_DESCRIPTION)
    expect(Object.keys(t.inputSchema.properties)).toEqual(Object.keys(MERGE_BRANCH_SHAPE))
    for (const [name, schema] of Object.entries(t.inputSchema.properties)) {
      expect(schema.description).toBe(MERGE_BRANCH_PARAMS[name as keyof typeof MERGE_BRANCH_PARAMS])
    }
  })

  it("the bridge's report_findings matches the shared description, params and finding fields", () => {
    const t = bridge.TOOLS.find((x) => x.name === 'report_findings')!
    expect(t.description).toBe(REPORT_FINDINGS_TOOL_DESCRIPTION)
    expect(Object.keys(t.inputSchema.properties)).toEqual(Object.keys(REPORT_FINDINGS_SHAPE))
    expect(t.inputSchema.required).toEqual(['findings'])
    for (const [name, schema] of Object.entries(t.inputSchema.properties)) {
      expect(schema.description).toBe(REPORT_FINDINGS_PARAMS[name as keyof typeof REPORT_FINDINGS_PARAMS])
    }
    const items = (t.inputSchema.properties.findings as { items: BridgeTool['inputSchema'] }).items
    expect(Object.keys(items.properties)).toEqual(Object.keys(REVIEW_FINDING_PARAMS))
    expect(items.required).toEqual(['file', 'summary', 'failure_scenario'])
    for (const [name, schema] of Object.entries(items.properties)) {
      expect(schema.description).toBe(REVIEW_FINDING_PARAMS[name as keyof typeof REVIEW_FINDING_PARAMS])
    }
  })
})

describe('app-mcp-bridge batch_rules', () => {
  it("the bridge's batch_rules matches the shared description and params, and maps to app.batchRules", () => {
    const t = bridge.TOOLS.find((x) => x.name === BATCH_RULES_TOOL_NAME)!
    expect(t.description).toBe(BATCH_RULES_TOOL_DESCRIPTION)
    expect(Object.keys(t.inputSchema.properties)).toEqual(Object.keys(BATCH_RULES_SHAPE))
    for (const [name, schema] of Object.entries(t.inputSchema.properties)) {
      expect(schema.description).toBe(BATCH_RULES_PARAMS[name as keyof typeof BATCH_RULES_PARAMS])
    }
  })
})

describe('app-mcp-bridge adopt_thread', () => {
  it("the bridge's adopt_thread matches the shared description and params, and maps to app.adoptThread", () => {
    const t = bridge.TOOLS.find((x) => x.name === ADOPT_THREAD_TOOL_NAME)!
    expect(t.description).toBe(ADOPT_THREAD_TOOL_DESCRIPTION)
    expect(Object.keys(t.inputSchema.properties)).toEqual(Object.keys(ADOPT_THREAD_SHAPE))
    for (const [name, schema] of Object.entries(t.inputSchema.properties)) {
      expect(schema.description).toBe(ADOPT_THREAD_PARAMS[name as keyof typeof ADOPT_THREAD_PARAMS])
    }
  })
})

describe('app-mcp-bridge archive_threads', () => {
  it("the bridge's archive_threads matches the shared description and params, and maps to app.archiveThreads", () => {
    const t = bridge.TOOLS.find((x) => x.name === ARCHIVE_THREADS_TOOL_NAME)!
    expect(t.description).toBe(ARCHIVE_THREADS_TOOL_DESCRIPTION)
    expect(Object.keys(t.inputSchema.properties)).toEqual(Object.keys(ARCHIVE_THREADS_SHAPE))
    for (const [name, schema] of Object.entries(t.inputSchema.properties)) {
      expect(schema.description).toBe(ARCHIVE_THREADS_PARAMS[name as keyof typeof ARCHIVE_THREADS_PARAMS])
    }
  })
})

describe('app-mcp-bridge batch_gate', () => {
  it("the bridge's batch_gate matches the shared description and params, and maps to app.batchGate", () => {
    const t = bridge.TOOLS.find((x) => x.name === BATCH_GATE_TOOL_NAME)!
    expect(t.description).toBe(BATCH_GATE_TOOL_DESCRIPTION)
    expect(Object.keys(t.inputSchema.properties)).toEqual(Object.keys(BATCH_GATE_SHAPE))
    for (const [name, schema] of Object.entries(t.inputSchema.properties)) {
      expect(schema.description).toBe(BATCH_GATE_PARAMS[name as keyof typeof BATCH_GATE_PARAMS])
    }
  })
})

describe('app-mcp-bridge skill tools', () => {
  it('copies the shared words, maps each to its app.skill* method and waits on a card with no client deadline', () => {
    const list = bridge.TOOLS.find((x) => x.name === SKILL_LIST_TOOL)!
    expect(list.description).toBe(SKILL_LIST_DESCRIPTION)
    expect(Object.keys(list.inputSchema.properties)).toEqual([])
    const write = bridge.TOOLS.find((x) => x.name === SKILL_WRITE_TOOL)!
    expect(write.description).toBe(SKILL_WRITE_DESCRIPTION)
    expect(Object.keys(write.inputSchema.properties)).toEqual(Object.keys(SKILL_WRITE_SHAPE))
    for (const [name, schema] of Object.entries(write.inputSchema.properties)) expect(schema.description).toBe(SKILL_WRITE_PARAMS[name as keyof typeof SKILL_WRITE_PARAMS])
    expect(write.inputSchema.required).toEqual(['name'])
    const remove = bridge.TOOLS.find((x) => x.name === SKILL_REMOVE_TOOL)!
    expect(remove.description).toBe(SKILL_REMOVE_DESCRIPTION)
    expect(Object.keys(remove.inputSchema.properties)).toEqual(Object.keys(SKILL_REMOVE_SHAPE))
    for (const [name, schema] of Object.entries(remove.inputSchema.properties)) expect(schema.description).toBe(SKILL_REMOVE_PARAMS[name as keyof typeof SKILL_REMOVE_PARAMS])
    expect([bridge.METHOD_FOR.skill_list, bridge.METHOD_FOR.skill_write, bridge.METHOD_FOR.skill_remove]).toEqual(['app.skillList', 'app.skillWrite', 'app.skillRemove'])
    expect([bridge.clientTimeoutMs('skill_write'), bridge.clientTimeoutMs('skill_remove'), bridge.clientTimeoutMs('skill_list')]).toEqual([0, 0, 120_000])
  })

  it('lists the three skill tools on every codex and Muse thread, with no add-on in scope', () => {
    const listed = (bridge as unknown as { listedTools: (macToken?: string, addons?: boolean) => BridgeTool[] }).listedTools(undefined, false).map((t) => t.name)
    expect(listed).toEqual(expect.arrayContaining([SKILL_LIST_TOOL, SKILL_WRITE_TOOL, SKILL_REMOVE_TOOL]))
  })
})

describe('app-mcp-bridge add-on tools', () => {
  type Listed = BridgeTool[]
  const addonBridge = bridge as unknown as {
    ADDON_TOOLS: Listed
    ADDON_CALL_TOOLS: Listed
    listedTools: (macToken?: string, addons?: boolean) => Listed
    METHOD_FOR: Record<string, string>
    clientTimeoutMs: (name: string, args?: unknown) => number
    toolResult: (name: string, result: unknown) => Record<string, unknown>
  }
  const byName = (name: string) => [...addonBridge.ADDON_TOOLS, ...addonBridge.ADDON_CALL_TOOLS].find((t) => t.name === name)!
  const same = (name: string, description: string, params: Record<string, string>) => {
    const t = byName(name)
    expect(t.description).toBe(description)
    expect(Object.keys(t.inputSchema.properties)).toEqual(Object.keys(params))
    for (const [key, schema] of Object.entries(t.inputSchema.properties)) expect(schema.description).toBe(params[key])
  }

  it("carries the shared words of every add-on tool", () => {
    expect(byName(addons.ADDON_LIST_TOOL).description).toBe(addons.ADDON_LIST_DESCRIPTION)
    same(addons.ADDON_ADD_TOOL, addons.ADDON_ADD_DESCRIPTION, addons.ADDON_ADD_PARAMS)
    same(addons.ADDON_REMOVE_TOOL, addons.ADDON_REMOVE_DESCRIPTION, addons.ADDON_REMOVE_PARAMS)
    same(addons.ADDON_FIND_TOOL, addons.ADDON_FIND_DESCRIPTION, addons.ADDON_FIND_PARAMS)
    same(addons.ADDON_CALL_TOOL, addons.ADDON_CALL_DESCRIPTION, addons.ADDON_CALL_PARAMS)
  })

  it('lists addon_find and addon_call only with add-ons in scope, the management tools always', () => {
    const names = (addonsOn: boolean) => addonBridge.listedTools(undefined, addonsOn).map((t) => t.name)
    expect(names(false)).toEqual(expect.arrayContaining(['addon_list', 'addon_add', 'addon_remove']))
    expect(names(false)).not.toContain('addon_find')
    expect(names(false)).not.toContain('addon_call')
    expect(names(true)).toEqual(expect.arrayContaining(['addon_find', 'addon_call']))
  })

  it('maps each tool to its app method, waits on the server for add, remove and call, and passes a call through whole', () => {
    expect(addonBridge.METHOD_FOR).toMatchObject({
      addon_list: 'app.addonList',
      addon_add: 'app.addonAdd',
      addon_remove: 'app.addonRemove',
      addon_find: 'app.addonFind',
      addon_call: 'app.addonCall'
    })
    expect(['addon_add', 'addon_remove', 'addon_call', 'addon_list', 'addon_find'].map((n) => addonBridge.clientTimeoutMs(n))).toEqual([0, 0, 0, 120_000, 120_000])
    const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' }
    expect(addonBridge.toolResult('addon_call', { content: [image], isError: true, structuredContent: { ok: false } })).toEqual({
      content: [image],
      isError: true,
      structuredContent: { ok: false }
    })
    expect(addonBridge.toolResult('addon_call', { content: [{ type: 'text', text: 'x' }] })).toEqual({ content: [{ type: 'text', text: 'x' }] })
    expect(addonBridge.toolResult('addon_list', '[]\nnote')).toEqual({ content: [{ type: 'text', text: '[]\nnote' }] })
  })

  it("bridgeMcpConfig gives a box thread its computer token while its Mac bridge offers computer use, and none otherwise", () => {
    setAppBridge({ port: 1, scriptPath: '/x.mjs', command: 'node', env: {} })
    const tokens = new MacThreadTokens(null, 'computer')
    computerBridgeHooks.current = { offered: (id: string) => id === 'bridged' } as unknown as ComputerBridge
    computerBridgeHooks.tokens = tokens
    try {
      const env = (id: string): Record<string, string> => bridgeMcpConfig(id, { computerImages: 'none' })!.env as Record<string, string>
      expect(env('bridged')).toMatchObject({ TEMP_CODE_COMPUTER_TOKEN: tokens.tokenFor('bridged'), TEMP_CODE_COMPUTER_IMAGES: 'none' })
      expect(env('plain').TEMP_CODE_COMPUTER_TOKEN).toBeUndefined()
    } finally {
      computerBridgeHooks.current = null
      computerBridgeHooks.tokens = null
      setAppBridge(null)
    }
  })

  it('bridgeMcpConfig sets TEMP_CODE_ADDONS while the thread\'s scope holds an add-on', () => {
    setAppBridge({ port: 1, scriptPath: '/x.mjs', command: 'node', env: {} })
    const hooks = { exposure: { attach: () => () => {} }, list: () => '', add: async () => '', remove: async () => '' }
    try {
      setAppAddons({ ...hooks, hasAddons: (id) => id === 'with' })
      expect((bridgeMcpConfig('with')!.env as Record<string, string>).TEMP_CODE_ADDONS).toBe('1')
      expect((bridgeMcpConfig('without')!.env as Record<string, string>).TEMP_CODE_ADDONS).toBeUndefined()
    } finally {
      setAppAddons(null)
      setAppBridge(null)
    }
  })
})
