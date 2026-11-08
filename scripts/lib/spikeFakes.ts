/**
 * The loopback servers and process plumbing of the config-dir spike
 * (scripts/spike-config-dirs.ts): a fake Anthropic and a fake Responses
 * front that record what a CLI sends (never a body, never a credential) and
 * answer a minimal stream, scripted when a run needs a tool call; the Muse
 * models recorder; the probe MCP server; tree listings; child tracking.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createTlsServer } from 'node:https'
import { dirname, join } from 'node:path'
import { PLACEHOLDERS, nonceHits, type TreeEntry } from './configDirSpike'

// ── processes ────────────────────────────────────────────────────────────────

const children = new Set<ChildProcess>()

/** A tracked child: killed by killChildren at the end, whatever happened. */
export function track<T extends ChildProcess>(proc: T): T {
  children.add(proc)
  proc.once('exit', () => children.delete(proc))
  return proc
}

export function spawnTracked(command: string, args: string[], opts: SpawnOptions): ChildProcess {
  return track(spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], ...opts }))
}

export async function killChildren(): Promise<void> {
  for (const p of children) if (p.exitCode === null) p.kill('SIGTERM')
  const end = Date.now() + 3_000
  while ([...children].some((p) => p.exitCode === null && p.signalCode === null) && Date.now() < end) await sleep(100)
  for (const p of children) if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL')
}

export const sleep = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms))

export async function within<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([p, new Promise<T>((_, bad) => (timer = setTimeout(() => bad(new Error(`timed out after ${ms} ms: ${label}`)), ms)))])
  } finally {
    clearTimeout(timer)
  }
}

/** Run a command to its end: exit code and output, bounded. */
export async function run(command: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number; input?: string } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((ok) => {
    let stdout = ''
    let stderr = ''
    let proc: ChildProcess
    try {
      proc = spawnTracked(command, args, { env: opts.env, cwd: opts.cwd })
    } catch (e) {
      ok({ code: null, stdout: '', stderr: (e as Error).message })
      return
    }
    const timer = setTimeout(() => proc.kill('SIGKILL'), opts.timeoutMs ?? 60_000)
    proc.stdout?.on('data', (d) => (stdout += d))
    proc.stderr?.on('data', (d) => (stderr += d))
    proc.on('error', (e) => {
      clearTimeout(timer)
      ok({ code: null, stdout, stderr: stderr + e.message })
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      ok({ code, stdout, stderr })
    })
    if (opts.input !== undefined) proc.stdin?.end(opts.input)
    else proc.stdin?.end()
  })
}

// ── trees ────────────────────────────────────────────────────────────────────

/** Every entry under `root` (links not followed), relative paths; `depth` caps the walk. */
export function listTree(root: string, depth = 12): TreeEntry[] {
  const out: TreeEntry[] = []
  const walk = (dir: string, rel: string, d: number): void => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names.sort()) {
      const path = join(dir, name)
      const relPath = rel ? `${rel}/${name}` : name
      let st
      try {
        st = lstatSync(path)
      } catch {
        continue
      }
      const kind: TreeEntry['kind'] = st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other'
      const entry: TreeEntry = { path: relPath, kind, size: st.size, mtimeMs: Math.round(st.mtimeMs) }
      if (kind === 'link') {
        try {
          entry.target = readlinkSync(path)
        } catch {
          // unreadable link
        }
      }
      out.push(entry)
      if (kind === 'dir' && d > 1) walk(path, relPath, d - 1)
    }
  }
  if (existsSync(root)) {
    const st = lstatSync(root)
    if (st.isDirectory()) walk(root, '', depth)
    else out.push({ path: '.', kind: st.isSymbolicLink() ? 'link' : 'file', size: st.size, mtimeMs: Math.round(st.mtimeMs) })
  }
  return out
}

/** Write a path → content map under `root`. */
export function writeTree(root: string, files: Record<string, string>): string {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  return root
}

// ── request bodies ───────────────────────────────────────────────────────────

const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((ok) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => ok(Buffer.concat(chunks)))
    req.on('error', () => ok(Buffer.concat(chunks)))
  })

const tokenKind = (token: string | null): 'placeholder' | 'other' | 'none' => (!token ? 'none' : PLACEHOLDERS.has(token) ? 'placeholder' : 'other')

function bearerOf(req: IncomingMessage): string | null {
  const h = req.headers.authorization
  return typeof h === 'string' && /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, '') : null
}

function listen(server: Server): Promise<number> {
  return new Promise((ok, bad) => {
    server.once('error', bad)
    server.listen(0, '127.0.0.1', () => ok((server.address() as { port: number }).port))
  })
}

function sse(res: ServerResponse, events: [string, Record<string, unknown>][]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  res.end()
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** A tool's first required property, else its first property, else `fallback`. */
function firstParam(schema: unknown, fallback: string): string {
  const s = (schema ?? {}) as { required?: string[]; properties?: Record<string, unknown> }
  return s.required?.[0] ?? Object.keys(s.properties ?? {})[0] ?? fallback
}

// ── the fake Anthropic ───────────────────────────────────────────────────────

/** One scripted answer to a main request: text, or a call of a tool picked from the request's tools. */
export type AnthropicAnswer =
  | { text: string }
  | { tool: (tools: { name: string; input_schema?: unknown }[]) => { name: string; input: Record<string, unknown> } | null }

export interface AnthropicRequestRecord {
  tag: string
  method: string
  path: string
  auth: 'bearer' | 'x-api-key' | 'none'
  token: 'placeholder' | 'other' | 'none'
  tokenLength: number
  betas: string[]
  model: string | null
  /** A request carrying tools: the conversation's own turn, not a side call. */
  main: boolean
  stream: boolean
  /** Which needles each part of the body held: the system prompt, the tool definitions, every message, the last message alone. */
  hits: { system: string[]; tools: string[]; messages: string[]; last: string[] }
  /** The probe's tools and the CLI's skill and agent tools, by name; nothing else. */
  tools: string[]
  answered: string
}

export class FakeAnthropic {
  url = ''
  requests: AnthropicRequestRecord[] = []
  needles: Record<string, string> = {}
  script: AnthropicAnswer[] = []
  tag = ''
  private server: Server
  private n = 0

  constructor() {
    this.server = createServer((req, res) => void this.handle(req, res))
    this.server.keepAliveTimeout = 60_000
  }

  async start(): Promise<this> {
    this.url = `http://127.0.0.1:${await listen(this.server)}`
    return this
  }

  /** A new run: its tag, its needles, an empty script. */
  reset(tag: string, needles: Record<string, string>): void {
    this.tag = tag
    this.needles = needles
    this.script = []
  }

  since(mark: number): AnthropicRequestRecord[] {
    return this.requests.slice(mark)
  }

  close(): void {
    this.server.closeAllConnections?.()
    this.server.close()
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x')
    const raw = await readBody(req)
    const bearer = bearerOf(req)
    const apiKey = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : null
    const token = bearer ?? apiKey
    const rec: AnthropicRequestRecord = {
      tag: this.tag,
      method: req.method ?? '',
      path: url.pathname,
      auth: bearer ? 'bearer' : apiKey ? 'x-api-key' : 'none',
      token: tokenKind(token),
      tokenLength: token?.length ?? 0,
      betas: String(req.headers['anthropic-beta'] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      model: null,
      main: false,
      stream: false,
      hits: { system: [], tools: [], messages: [], last: [] },
      tools: [],
      answered: ''
    }
    this.requests.push(rec)
    if (url.pathname === '/v1/messages' && req.method === 'POST') {
      let body: { model?: string; stream?: boolean; system?: unknown; tools?: { name: string; input_schema?: unknown }[]; messages?: unknown[] } = {}
      try {
        body = JSON.parse(raw.toString('utf8') || '{}') as typeof body
      } catch {
        // an unreadable body is answered as a side call
      }
      rec.model = body.model ?? null
      rec.stream = !!body.stream
      const tools = Array.isArray(body.tools) ? body.tools : []
      rec.main = tools.length > 0 && Array.isArray(body.messages)
      rec.tools = tools.map((t) => t.name).filter((n) => /^mcp__|^Skill$|^Agent$|^Task$|tc[-_]probe/.test(n))
      const messages = Array.isArray(body.messages) ? body.messages : []
      rec.hits = {
        system: nonceHits(JSON.stringify(body.system ?? ''), this.needles),
        tools: nonceHits(JSON.stringify(tools), this.needles),
        messages: nonceHits(JSON.stringify(messages), this.needles),
        last: nonceHits(JSON.stringify(messages.at(-1) ?? ''), this.needles)
      }
      const next = rec.main ? this.script.shift() : undefined
      const call = next && 'tool' in next ? next.tool(tools) : null
      const id = `msg_tc_${++this.n}`
      const model = body.model ?? 'claude-haiku-5-5'
      if (call) {
        rec.answered = `tool:${call.name}`
        const block = { type: 'tool_use', id: `toolu_tc_${this.n}`, name: call.name, input: call.input }
        if (!body.stream) return json(res, 200, { id, type: 'message', role: 'assistant', model, content: [block], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 12, output_tokens: 5 } })
        return sse(res, [
          ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } }],
          ['content_block_start', { type: 'content_block_start', index: 0, content_block: { ...block, input: {} } }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } }],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } }],
          ['message_stop', { type: 'message_stop' }]
        ])
      }
      const text = next && 'text' in next ? next.text : 'ok'
      rec.answered = 'text'
      if (!body.stream) return json(res, 200, { id, type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } })
      return sse(res, [
        ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
        ['message_stop', { type: 'message_stop' }]
      ])
    }
    rec.answered = 'aux'
    if (url.pathname === '/v1/messages/count_tokens') return json(res, 200, { input_tokens: 12 })
    if (url.pathname === '/api/oauth/profile') return json(res, 200, { account: { uuid: 'u-tc-placeholder', email: 'tc-placeholder@example.invalid' }, organization: { uuid: 'org-tc-placeholder', name: 'TC Placeholder', organization_type: 'claude_max' } })
    if (url.pathname.startsWith('/api/oauth/usage')) return json(res, 200, {})
    if (url.pathname === '/v1/models') return json(res, 200, { data: [], has_more: false })
    rec.answered = '404'
    json(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'fake: not here' } })
  }
}

/** A Skill call naming `skill`, keyed by the Skill tool's own first parameter. */
export const skillCall =
  (skill: string): AnthropicAnswer['tool'] =>
  (tools) => {
    const t = tools.find((x) => x.name === 'Skill')
    return t ? { name: 'Skill', input: { [firstParam(t.input_schema, 'skill')]: skill } } : null
  }

/** A call of the first tool whose name ends with `suffix`. */
export const toolEndingWith =
  (suffix: string, input: Record<string, unknown> = {}): AnthropicAnswer['tool'] =>
  (tools) => {
    const t = tools.find((x) => x.name.endsWith(suffix))
    return t ? { name: t.name, input } : null
  }

/** A Bash call running `command`. */
export const bashCall =
  (command: string): AnthropicAnswer['tool'] =>
  (tools) =>
    tools.some((t) => t.name === 'Bash') ? { name: 'Bash', input: { command, description: 'probe' } } : null

// ── the fake Responses front (codex and Muse) ────────────────────────────────

export type ResponsesAnswer = { text: string } | { shell: string }

export interface ResponsesRequestRecord {
  tag: string
  method: string
  path: string
  bearer: 'placeholder' | 'other' | 'none'
  bearerLength: number
  accountId: 'placeholder' | 'other' | 'none'
  /** x-tbh-* and x-codex-* header names (never values). */
  headerNames: string[]
  role: string | null
  model: string | null
  main: boolean
  hits: { instructions: string[]; input: string[]; tools: string[]; last: string[] }
  tools: string[]
  answered: string
}

interface ResponsesTool {
  type?: string
  name?: string
  parameters?: unknown
}

/**
 * The Responses wire as codex (https, `/backend-api/codex/responses`) and
 * Muse (http, `/responses` and `GET /muse-code/models`) speak it. Refuses
 * WebSocket upgrades with 426, as the gateway does, so codex drops to HTTP.
 * `forward` turns it into a pass-through to another origin (a real run).
 */
export class FakeResponses {
  url = ''
  requests: ResponsesRequestRecord[] = []
  needles: Record<string, string> = {}
  script: ResponsesAnswer[] = []
  tag = ''
  /** The body `GET /muse-code/models` answers, null: 404. */
  museModels: string | null = null
  /** A real run: where each request goes instead of being answered here. */
  forward: ((path: string) => string) | null = null
  private server: Server
  private n = 0

  constructor(tls: { cert: Buffer; key: Buffer } | null) {
    this.server = tls ? createTlsServer({ cert: tls.cert, key: tls.key }, (req, res) => void this.handle(req, res)) : createServer((req, res) => void this.handle(req, res))
    this.server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 426 Upgrade Required\r\nconnection: close\r\ncontent-length: 0\r\n\r\n'))
    this.scheme = tls ? 'https' : 'http'
  }

  private readonly scheme: 'http' | 'https'

  async start(): Promise<this> {
    this.url = `${this.scheme}://127.0.0.1:${await listen(this.server)}`
    return this
  }

  reset(tag: string, needles: Record<string, string>): void {
    this.tag = tag
    this.needles = needles
    this.script = []
    this.forward = null
  }

  since(mark: number): ResponsesRequestRecord[] {
    return this.requests.slice(mark)
  }

  close(): void {
    this.server.closeAllConnections?.()
    this.server.close()
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x')
    const raw = await readBody(req)
    const bearer = bearerOf(req)
    const account = typeof req.headers['chatgpt-account-id'] === 'string' ? req.headers['chatgpt-account-id'] : null
    const rec: ResponsesRequestRecord = {
      tag: this.tag,
      method: req.method ?? '',
      path: url.pathname,
      bearer: tokenKind(bearer),
      bearerLength: bearer?.length ?? 0,
      accountId: tokenKind(account),
      headerNames: Object.keys(req.headers)
        .filter((h) => /^x-(tbh|codex|meta)/.test(h))
        .sort(),
      role: typeof req.headers['x-tbh-agent-role'] === 'string' ? req.headers['x-tbh-agent-role'] : null,
      model: null,
      main: false,
      hits: { instructions: [], input: [], tools: [], last: [] },
      tools: [],
      answered: ''
    }
    this.requests.push(rec)
    if (this.forward) {
      rec.answered = 'forwarded'
      return this.pass(req, res, raw, this.forward(req.url ?? '/'))
    }
    if (req.method === 'GET' && url.pathname.endsWith('/muse-code/models')) {
      rec.answered = this.museModels ? 'models' : '404'
      if (this.museModels) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(this.museModels)
        return
      }
      return json(res, 404, { error: 'fake: no recorded models' })
    }
    if (req.method === 'POST' && url.pathname.endsWith('/responses')) {
      let body: { model?: string; instructions?: unknown; input?: unknown[]; tools?: ResponsesTool[] } = {}
      try {
        body = JSON.parse(raw.toString('utf8') || '{}') as typeof body
      } catch {
        // answered as a plain turn
      }
      const tools = Array.isArray(body.tools) ? body.tools : []
      const input = Array.isArray(body.input) ? body.input : []
      rec.model = body.model ?? null
      rec.tools = tools.map((t) => t.name ?? t.type ?? '?')
      rec.main = rec.role ? rec.role === 'main' : tools.length > 0
      rec.hits = {
        instructions: nonceHits(JSON.stringify(body.instructions ?? ''), this.needles),
        input: nonceHits(JSON.stringify(input), this.needles),
        tools: nonceHits(JSON.stringify(tools), this.needles),
        last: nonceHits(JSON.stringify(input.at(-1) ?? ''), this.needles)
      }
      const next = rec.main ? this.script.shift() : undefined
      const shellItem = next && 'shell' in next ? this.shellItem(tools, next.shell) : null
      const text = next && 'text' in next ? next.text : 'ok'
      rec.answered = shellItem ? `call:${(shellItem.name as string | undefined) ?? shellItem.type}` : 'text'
      return this.stream(res, body.model ?? 'fake', shellItem ?? null, text)
    }
    rec.answered = '404'
    json(res, 404, { error: { message: 'fake: not here' } })
  }

  /** The output item that runs `command` through the request's own shell tool. */
  private shellItem(tools: ResponsesTool[], command: string): Record<string, unknown> | null {
    const id = `call_tc_${++this.n}`
    const fn = tools.find((t) => (t.type ?? 'function') === 'function' && /^(shell|exec_command|shell_command|bash|run_shell|execute)$/.test(t.name ?? '')) ?? tools.find((t) => (t.type ?? 'function') === 'function' && /shell|exec|bash/.test(t.name ?? ''))
    if (fn) {
      const props = ((fn.parameters ?? {}) as { properties?: Record<string, { type?: string }> }).properties ?? {}
      const key = 'cmd' in props ? 'cmd' : 'command' in props ? 'command' : firstParam(fn.parameters, 'command')
      const value = props[key]?.type === 'array' ? ['bash', '-lc', command] : command
      return { type: 'function_call', id: `fc_tc_${this.n}`, call_id: id, name: fn.name, arguments: JSON.stringify({ [key]: value }), status: 'completed' }
    }
    if (tools.some((t) => t.type === 'local_shell')) return { type: 'local_shell_call', id: `lsh_tc_${this.n}`, call_id: id, status: 'completed', action: { type: 'exec', command: ['bash', '-lc', command] } }
    return null
  }

  private stream(res: ServerResponse, model: string, call: Record<string, unknown> | null, text: string): void {
    const id = `resp_tc_${++this.n}`
    let seq = 0
    const ev = (type: string, data: Record<string, unknown>): [string, Record<string, unknown>] => [type, { type, sequence_number: seq++, ...data }]
    const created = { id, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress', model, output: [] }
    const usage = { input_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens: 3, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 }
    const events: [string, Record<string, unknown>][] = [ev('response.created', { response: created }), ev('response.in_progress', { response: created })]
    let item: Record<string, unknown>
    if (call) {
      item = call
      events.push(ev('response.output_item.added', { output_index: 0, item: { ...call, status: 'in_progress', ...(call.type === 'function_call' ? { arguments: '' } : {}) } }))
      if (call.type === 'function_call') {
        events.push(ev('response.function_call_arguments.delta', { item_id: call.id, output_index: 0, delta: call.arguments }))
        events.push(ev('response.function_call_arguments.done', { item_id: call.id, output_index: 0, arguments: call.arguments }))
      }
      events.push(ev('response.output_item.done', { output_index: 0, item: call }))
    } else {
      const msgId = `msg_tc_${this.n}`
      const part = { type: 'output_text', text, annotations: [] }
      item = { id: msgId, type: 'message', status: 'completed', role: 'assistant', content: [part] }
      events.push(ev('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } }))
      events.push(ev('response.content_part.added', { item_id: msgId, output_index: 0, content_index: 0, part: { ...part, text: '' } }))
      events.push(ev('response.output_text.delta', { item_id: msgId, output_index: 0, content_index: 0, delta: text }))
      events.push(ev('response.output_text.done', { item_id: msgId, output_index: 0, content_index: 0, text }))
      events.push(ev('response.content_part.done', { item_id: msgId, output_index: 0, content_index: 0, part }))
      events.push(ev('response.output_item.done', { output_index: 0, item }))
    }
    events.push(ev('response.completed', { response: { ...created, status: 'completed', output: [item], usage } }))
    sse(res, events)
  }

  /** A real run: the request goes on to `target` as it came, the answer comes back as it went. */
  private async pass(req: IncomingMessage, res: ServerResponse, body: Buffer, target: string): Promise<void> {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && !/^(host|connection|content-length|accept-encoding|upgrade)$/i.test(k)) headers[k] = v
    try {
      const r = await fetch(target, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body })
      const out: Record<string, string> = {}
      r.headers.forEach((v, k) => {
        if (!/^(content-encoding|content-length|transfer-encoding|connection)$/i.test(k)) out[k] = v
      })
      res.writeHead(r.status, out)
      if (r.body) for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk)
      res.end()
    } catch (e) {
      json(res, 502, { error: { message: `forward failed: ${(e as Error).message}` } })
    }
  }
}

// ── M0b: the Muse models recorder ────────────────────────────────────────────

/**
 * `muse serve -c endpoint_transport.base_url=<this>`: `GET /muse-code/models`
 * goes on to each candidate origin with the CLI's own headers, in memory, and
 * the first 2xx answer is kept; every other path is refused.
 */
export class ModelsRecorder {
  url = ''
  answer: { origin: string; status: number; body: string } | null = null
  tried: { origin: string; status: number | string }[] = []
  refused: string[] = []
  private server: Server

  constructor(private readonly candidates: string[]) {
    this.server = createServer((req, res) => void this.handle(req, res))
  }

  async start(): Promise<this> {
    this.url = `http://127.0.0.1:${await listen(this.server)}`
    return this
  }

  close(): void {
    this.server.closeAllConnections?.()
    this.server.close()
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x')
    await readBody(req)
    if (req.method !== 'GET' || !url.pathname.endsWith('/muse-code/models')) {
      this.refused.push(`${req.method} ${url.pathname}`)
      return json(res, 404, { error: 'recorder: refused' })
    }
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && !/^(host|connection|accept-encoding)$/i.test(k)) headers[k] = v
    for (const origin of this.candidates) {
      try {
        const r = await fetch(`${origin}/muse-code/models${url.search}`, { headers })
        const body = await r.text()
        this.tried.push({ origin, status: r.status })
        if (r.ok) {
          this.answer = { origin, status: r.status, body }
          res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' })
          res.end(body)
          return
        }
      } catch (e) {
        this.tried.push({ origin, status: (e as Error).message })
      }
    }
    json(res, 502, { error: 'recorder: no candidate answered' })
  }
}

// ── the probe MCP server ─────────────────────────────────────────────────────

/** A stdio MCP server with one tool, `tc_probe_echo`, answering with the nonce in argv[2]. */
export const PROBE_MCP_SOURCE = `import { createInterface } from 'node:readline'
const nonce = process.argv[2] || 'none'
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  let m
  try { m = JSON.parse(line) } catch { return }
  if (m.id === undefined || m.id === null) return
  const ok = (result) => send({ jsonrpc: '2.0', id: m.id, result })
  if (m.method === 'initialize') return ok({ protocolVersion: (m.params && m.params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'tc-probe', version: '0.0.1' } })
  if (m.method === 'tools/list') return ok({ tools: [{ name: 'tc_probe_echo', description: 'Echo the probe word', inputSchema: { type: 'object', properties: { word: { type: 'string' } } } }] })
  if (m.method === 'tools/call') return ok({ content: [{ type: 'text', text: 'tc-probe-echo ' + nonce }] })
  ok({})
})
`
