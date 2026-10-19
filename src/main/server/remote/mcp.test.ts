/* eslint-disable @typescript-eslint/no-explicit-any */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { configure } from 'aliax-core'
import type { RunningServer } from '../index'
import { MCP_MAX_BODY, MCP_RATE_PER_MINUTE, describeTools } from './mcp'

/**
 * `/mcp` over the real listener: auth by x-api-key and bearer, the
 * audience rule, initialize/ping/tools/list/tools/call, notifications,
 * batches, the SSE answer, GET/DELETE, the body cap and the rate limit.
 * The harness never spawns: registry.send is a fake that lands the row.
 */
let root: string
let server: RunningServer
let base: string
let botKey: string
let readKey: string
let clientKey: string

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'tc-mcp-'))
  configure({
    dataDir: join(root, 'aliax'),
    fetch: async () => {
      throw new Error('no network in tests')
    },
    secrets: { mode: 'chromiumKey', keychainItem: 'Test Safe Storage' },
    appName: 'temp-code-test'
  })
  const repo = join(root, 'scratch')
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  writeFileSync(join(repo, 'README.md'), 'hello\n')
  execFileSync('git', ['-C', repo, 'add', '.'])
  execFileSync('git', [
    '-C',
    repo,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-q',
    '-m',
    'init'
  ])
  const { startServer } = await import('../index')
  server = await startServer(join(root, 'app.db'), {
    claimShim: false,
    remotePort: 0,
    appPath: root
  })
  base = `http://127.0.0.1:${server.remote!.port}`
  const ws = await server.registry.createWorkspace(repo, 'scratch')
  await server.registry.createProject(ws.id, 'main-work', 'local')
  vi.spyOn(server.registry, 'send').mockImplementation(async (id: string, text: string) => {
    server.registry.append(id, { type: 'user-text', text })
  })
  botKey = (
    await server.remoteAuth.createKey({
      name: 'grok',
      audience: 'mcp',
      caps: ['operate'],
      createdBy: 'local'
    })
  ).token
  readKey = (
    await server.remoteAuth.createKey({
      name: 'watcher',
      audience: 'mcp',
      caps: [],
      createdBy: 'local'
    })
  ).token
  clientKey = (
    await server.remoteAuth.createKey({
      name: 'phone',
      audience: 'client',
      caps: ['operate'],
      createdBy: 'local'
    })
  ).token
}, 60_000)
afterAll(async () => {
  await server.close()
  rmSync(root, { recursive: true, force: true })
})

type Reply = { status: number; headers: Headers; body: any; text: string }
async function post(
  body: unknown,
  init: { headers?: Record<string, string>; key?: string | null; raw?: string } = {}
): Promise<Reply> {
  const key = init.key === undefined ? botKey : init.key
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(key ? { 'x-api-key': key } : {}),
      ...init.headers
    },
    body: init.raw ?? JSON.stringify(body)
  })
  const text = await res.text()
  let parsed: unknown = null
  try {
    parsed = JSON.parse(text)
  } catch {
    /* not json */
  }
  return { status: res.status, headers: res.headers, body: parsed, text }
}
let nextId = 1
const rpc = (
  method: string,
  params?: unknown
): { jsonrpc: '2.0'; id: number; method: string; params?: unknown } => ({
  jsonrpc: '2.0',
  id: nextId++,
  method,
  ...(params === undefined ? {} : { params })
})
const tool = (
  name: string,
  args: unknown = {},
  init?: Parameters<typeof post>[1]
): Promise<Reply> => post(rpc('tools/call', { name, arguments: args }), init)
const result = (reply: Reply): any => reply.body.result.structuredContent

describe('auth', () => {
  it('needs a key', async () => {
    const r = await post(rpc('ping'), { key: null })
    expect(r.status).toBe(401)
    expect(r.headers.get('www-authenticate')).toBe('Bearer')
    expect(r.body.error).toMatch(/x-api-key or Authorization: Bearer/)
  })
  it('refuses a bad key and a client key, takes x-api-key or a bearer', async () => {
    expect((await post(rpc('ping'), { key: 'tc_nope.secret' })).status).toBe(401)
    const client = await post(rpc('ping'), { key: clientKey })
    expect(client.status).toBe(403)
    expect(client.body.error).toMatch(/audience client.*audience mcp/)
    expect((await post(rpc('ping'))).status).toBe(200)
    const bearer = await post(rpc('ping'), {
      key: null,
      headers: { Authorization: `Bearer ${botKey}` }
    })
    expect(bearer.status).toBe(200)
    expect(bearer.body.result).toEqual({})
  })
})

describe('protocol', () => {
  it('initializes with the negotiated version, a session id and instructions', async () => {
    const r = await post(
      rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' }
      })
    )
    expect(r.status).toBe(200)
    expect(r.body.result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'temp-code' }
    })
    expect(r.body.result.instructions).toMatch(/list_projects → start_session/)
    expect(r.headers.get('mcp-session-id')).toMatch(/^[0-9a-f]{32}$/)
    const old = await post(rpc('initialize', { protocolVersion: '1999-01-01' }))
    expect(old.body.result.protocolVersion).toBe('2025-06-18')
    const latest = await post(rpc('initialize', { protocolVersion: '2025-11-25' }), {
      headers: { 'mcp-session-id': 'whatever' }
    })
    expect(latest.body.result.protocolVersion).toBe('2025-11-25')
  })
  it('accepts notifications with 202, answers batches, and rejects junk', async () => {
    const n = await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(n.status).toBe(202)
    expect(n.text).toBe('')
    const batch = await post([
      rpc('ping'),
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: {} },
      rpc('nope')
    ])
    expect(batch.status).toBe(200)
    expect(batch.body.length).toBe(2)
    expect(batch.body[1].error.code).toBe(-32601)
    const bad = await post(null, { raw: '{not json' })
    expect(bad.status).toBe(400)
    expect(bad.body.error.code).toBe(-32700)
    const notRpc = await post({ id: 1, method: 'ping' })
    expect(notRpc.body.error.code).toBe(-32600)
    const noParams = await post({ jsonrpc: '2.0', id: 9, method: 'tools/call' })
    expect(noParams.body.error.code).toBe(-32602)
  })
  it('answers with an SSE stream when the client accepts only that; GET is 405; DELETE ends the session', async () => {
    const sse = await post(rpc('ping'), { headers: { Accept: 'text/event-stream' } })
    expect(sse.status).toBe(200)
    expect(sse.headers.get('content-type')).toBe('text/event-stream')
    expect(sse.text).toMatch(
      /^event: message\ndata: \{"jsonrpc":"2.0","id":\d+,"result":\{\}\}\n\n$/
    )
    const get = await fetch(`${base}/mcp`, {
      headers: { 'x-api-key': botKey, Accept: 'text/event-stream' }
    })
    expect(get.status).toBe(405)
    expect(get.headers.get('allow')).toBe('POST, DELETE')
    const del = await fetch(`${base}/mcp`, { method: 'DELETE', headers: { 'x-api-key': botKey } })
    expect(del.status).toBe(204)
    const unauth = await fetch(`${base}/mcp`, { headers: { Accept: 'text/event-stream' } })
    expect(unauth.status).toBe(401)
  })
  it('caps the body', async () => {
    const r = await post(null, {
      raw: JSON.stringify({ ...rpc('ping'), params: { pad: 'x'.repeat(MCP_MAX_BODY) } })
    })
    expect(r.status).toBe(413)
  })
})

describe('tools', () => {
  it('lists the facade tools with JSON schemas and hints', async () => {
    const r = await post(rpc('tools/list'))
    const tools = r.body.result.tools as ReturnType<typeof describeTools>
    expect(tools.map((t) => t.name)).toEqual([
      'list_projects',
      'list_sessions',
      'start_session',
      'send_message',
      'get_session',
      'get_transcript',
      'list_pending',
      'respond',
      'stop_session',
      'archive_session',
      'get_diff'
    ])
    const start = tools.find((t) => t.name === 'start_session')!
    expect(start.inputSchema).toMatchObject({ type: 'object', required: ['repo', 'prompt'] })
    expect(
      (start.inputSchema.properties as Record<string, { description: string }>).model.description
    ).toMatch(/"claude" or "codex"/)
    expect(start.inputSchema).not.toHaveProperty('$schema')
    expect(start.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    })
    expect(tools.find((t) => t.name === 'get_session')!.annotations.readOnlyHint).toBe(true)
    expect(tools.find((t) => t.name === 'stop_session')!.annotations.destructiveHint).toBe(true)
  })
  it('runs a session through the facade', async () => {
    const projects = await tool('list_projects')
    expect(projects.status).toBe(200)
    expect(result(projects).repos[0]).toMatchObject({
      name: 'scratch',
      projects: [{ name: 'main-work', branch: 'main' }]
    })
    expect(JSON.parse(projects.body.result.content[0].text)).toEqual(result(projects))
    const started = result(
      await tool('start_session', {
        repo: 'scratch',
        prompt: 'Say hi',
        model: 'claude',
        type: 'chat',
        title: 'hi'
      })
    )
    expect(started).toMatchObject({
      title: 'hi',
      repo: 'scratch',
      provider: 'claude',
      status: 'done'
    })
    const session = started.id as string
    server.registry.append(session, { type: 'assistant-text', text: 'hi there', delta: false })
    server.registry.append(session, {
      type: 'question-request',
      requestId: 'q1',
      questions: [{ question: 'Louder?', options: [{ label: 'yes' }, { label: 'no' }] }]
    })
    server.registry.append(session, { type: 'status', status: 'waiting' })
    expect(result(await tool('get_session', { session }))).toMatchObject({
      status: 'waiting',
      pending: 'question',
      lastSaid: 'hi there'
    })
    const transcript = result(await tool('get_transcript', { session }))
    expect(transcript.text).toContain('user: Say hi')
    expect(transcript.text).toContain('QUESTION q1: Louder? [yes | no]')
    const pending = result(await tool('list_pending', {}))
    expect(pending.pending.map((p: { requestId: string }) => p.requestId)).toEqual(['q1'])
    expect(
      result(await tool('respond', { session, requestId: 'q1', answer: 'yes' }))
    ).toMatchObject({ ok: true, kind: 'question' })
    server.registry.append(session, { type: 'status', status: 'idle' })
    expect(result(await tool('send_message', { session, text: 'thanks' }))).toMatchObject({
      ok: true,
      delivered: 'sent'
    })
    const stopped = result(await tool('stop_session', { session }))
    expect(stopped).toMatchObject({ ok: true })
    expect(result(await tool('archive_session', { session }))).toEqual({
      ok: true,
      session,
      archived: true
    })
  })
  it('turns facade refusals and bad arguments into tool errors the model can read', async () => {
    const started = result(
      await tool('start_session', { repo: 'scratch', prompt: 'x', type: 'chat' })
    )
    server.registry.append(started.id, {
      type: 'approval-request',
      requestId: 'a1',
      toolName: 'Bash',
      input: { command: 'rm -rf /' }
    })
    server.registry.append(started.id, { type: 'status', status: 'waiting' })
    const refused = await tool('respond', { session: started.id, requestId: 'a1', allow: true })
    expect(refused.status).toBe(200)
    expect(refused.body.result.isError).toBe(true)
    expect(refused.body.result.content[0].text).toMatch(
      /cannot approve permission prompts.*Tell the user to answer it in temp-code/
    )
    const missing = await tool('get_session', {})
    expect(missing.body.result.isError).toBe(true)
    expect(missing.body.result.content[0].text).toMatch(/invalid arguments: session/)
    const unknown = await tool('nope')
    expect(unknown.body.result.content[0].text).toMatch(/unknown tool "nope"/)
    const readOnly = await tool('start_session', { repo: 'scratch', prompt: 'x' }, { key: readKey })
    expect(readOnly.body.result.isError).toBe(true)
    expect(readOnly.body.result.content[0].text).toMatch(
      /needs the operate capability; this key has read/
    )
    expect((await tool('list_sessions', {}, { key: readKey })).body.result.isError).toBeUndefined()
  })
  it('rate limits per key', async () => {
    const key = (
      await server.remoteAuth.createKey({
        name: 'chatty',
        audience: 'mcp',
        caps: [],
        createdBy: 'local'
      })
    ).token
    const replies: number[] = []
    for (let i = 0; i < MCP_RATE_PER_MINUTE + 1; i++)
      replies.push((await post(rpc('ping'), { key })).status)
    expect(replies.slice(0, MCP_RATE_PER_MINUTE).every((s) => s === 200)).toBe(true)
    expect(replies[MCP_RATE_PER_MINUTE]).toBe(429)
    const limited = await post(rpc('ping'), { key })
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/)
    expect((await post(rpc('ping'))).status).toBe(200)
  })
})
