/**
 * A fake downstream MCP server for the add-on host's tests and its e2e
 * (plan-L1Vrd-CMiZJ7.md section 10). Runs under node (type stripping) or
 * bun, over stdio or http:
 *
 *   fakeMcpServer.ts --stdio [--log <file>] [--many <n>]
 *   fakeMcpServer.ts --http <port> [--sse <port>] [--require <Header>=<value>] [--log <file>]
 *
 * http listens on 127.0.0.1 and prints one JSON line `{"http":<port>,"sse":<port>}`
 * once up: Streamable HTTP at /mcp (stateful), and on the SSE port an
 * SSE-only server at /sse that answers 405 to a POST there. `--require`
 * answers 401 to every request without that header value. Every tool call
 * appends one JSON line to the log file.
 *
 * Tools: echo, read (readOnly), image, whoami (sha256 prefix of FAKE_TOKEN,
 * or of the required header's value), env (the variable names it sees),
 * crash (a line on stderr, exit 3; `signal: true` kills itself, `token: true`
 * prints FAKE_TOKEN), slow (waits `ms`, logs a cancel; `fail: true` then
 * throws FAKE_TOKEN as it was at the call), fail (an isError result; `token: true` names FAKE_TOKEN in it), big (`bytes` of text), structured, fail (isError),
 * printtoken (writes FAKE_TOKEN to stderr and throws it), add_tool (adds a
 * tool and sends tools/list_changed). tools/list pages eight at a time.
 */
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1] : undefined
}
const LOG = flag('--log')
const PAGE = 8
const REQUIRE = flag('--require')
const [REQUIRED_HEADER, REQUIRED_VALUE] = REQUIRE ? [REQUIRE.slice(0, REQUIRE.indexOf('=')).toLowerCase(), REQUIRE.slice(REQUIRE.indexOf('=') + 1)] : [null, null]
// A 1×1 transparent PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

const prefix = (value: string | undefined): string => (value ? createHash('sha256').update(value).digest('hex').slice(0, 12) : 'none')
const log = (entry: Record<string, unknown>): void => {
  if (LOG) appendFileSync(LOG, JSON.stringify({ at: Date.now(), pid: process.pid, ...entry }) + '\n')
}

type ToolDef = { name: string; description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> }
const obj = (properties: Record<string, unknown> = {}, required: string[] = []): Record<string, unknown> => ({ type: 'object', properties, required })
const tools: ToolDef[] = [
  { name: 'echo', description: 'Echo the text back unchanged', inputSchema: obj({ text: { type: 'string', description: 'What to echo' } }, ['text']) },
  { name: 'read', description: 'Read a value without changing anything', inputSchema: obj({ key: { type: 'string' } }), annotations: { readOnlyHint: true } },
  { name: 'image', description: 'Answer a one-pixel image', inputSchema: obj() },
  { name: 'whoami', description: 'Answer the sha256 prefix of the token this server got', inputSchema: obj() },
  { name: 'env', description: 'Answer the environment variable names this server sees', inputSchema: obj() },
  { name: 'crash', description: 'Exit with code 3 after a line on stderr', inputSchema: obj({ signal: { type: 'boolean' }, token: { type: 'boolean' } }) },
  { name: 'slow', description: 'Wait the given milliseconds', inputSchema: obj({ ms: { type: 'number' }, fail: { type: 'boolean' } }, ['ms']) },
  { name: 'big', description: 'Answer a text of the given size', inputSchema: obj({ bytes: { type: 'number' } }, ['bytes']) },
  { name: 'structured', description: 'Answer content with structuredContent', inputSchema: obj() },
  { name: 'fail', description: 'Answer an error result', inputSchema: obj({ token: { type: 'boolean' } }) },
  { name: 'printtoken', description: 'Print the token to stderr and throw it', inputSchema: obj() },
  { name: 'add_tool', description: 'Add a tool and announce the list changed', inputSchema: obj({ name: { type: 'string' } }, ['name']) }
]
for (let i = 0; i < Number(flag('--many') ?? 0); i++) tools.push({ name: `t${String(i).padStart(3, '0')}`, description: `Filler ${i}`, inputSchema: obj() })

function makeServer(headerValue: () => string | undefined): Server {
  const server = new Server({ name: 'fake', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } })
  server.setRequestHandler(ListToolsRequestSchema, async (req) => {
    const from = Number(req.params?.cursor ?? 0)
    const page = tools.slice(from, from + PAGE)
    return { tools: page, ...(from + PAGE < tools.length ? { nextCursor: String(from + PAGE) } : {}) }
  })
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>
    const name = req.params.name
    log({ tool: name, arguments: args })
    const text = (t: string) => ({ content: [{ type: 'text', text: t }] })
    switch (name) {
      case 'echo':
        return text(String(args.text ?? ''))
      case 'read':
        return text(`read ${String(args.key ?? '')}`)
      case 'image':
        return { content: [{ type: 'image', data: PNG, mimeType: 'image/png' }] }
      case 'whoami':
        return text(prefix(REQUIRED_HEADER ? headerValue() : process.env.FAKE_TOKEN))
      case 'env':
        return text(JSON.stringify(Object.keys(process.env).sort()))
      case 'crash':
        process.stderr.write(args.token ? `crashing with token ${process.env.FAKE_TOKEN}\n` : 'fake crashing on purpose\n')
        if (args.signal) process.kill(process.pid, 'SIGKILL')
        else setTimeout(() => process.exit(3), 10)
        return new Promise(() => {})
      case 'slow':
        return new Promise((resolve, reject) => {
          const token = process.env.FAKE_TOKEN
          const timer = setTimeout(() => (args.fail ? reject(new Error(`slow failed with token ${token}`)) : resolve(text(`waited ${Number(args.ms)}`))), Number(args.ms))
          extra.signal.addEventListener('abort', () => {
            clearTimeout(timer)
            log({ tool: 'slow', cancelled: true })
          })
        })
      case 'big':
        return text('x'.repeat(Number(args.bytes)))
      case 'structured':
        return { content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true } }
      case 'fail':
        return args.token
          ? { content: [{ type: 'text', text: `failed with token ${process.env.FAKE_TOKEN}` }], structuredContent: { token: process.env.FAKE_TOKEN }, isError: true }
          : { content: [{ type: 'text', text: 'failed on purpose' }], isError: true }
      case 'printtoken':
        process.stderr.write(`my token is ${process.env.FAKE_TOKEN}\n`)
        throw new Error(`bad token ${process.env.FAKE_TOKEN}`)
      case 'add_tool':
        tools.push({ name: String(args.name), description: 'Added at run time', inputSchema: obj() })
        await server.sendToolListChanged()
        return text('added')
      default:
        if (tools.some((t) => t.name === name)) return text(name)
        throw new Error(`unknown tool ${name}`)
    }
  })
  return server
}

const refused = (req: IncomingMessage, res: ServerResponse): boolean => {
  if (!REQUIRED_HEADER || req.headers[REQUIRED_HEADER] === REQUIRED_VALUE) return false
  res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}')
  return true
}

if (argv.includes('--stdio')) {
  await makeServer(() => undefined).connect(new StdioServerTransport())
} else {
  const sessions = new Map<string, StreamableHTTPServerTransport>()
  let lastHeader: string | undefined
  const http = createServer(async (req, res) => {
    if (refused(req, res)) return
    lastHeader = REQUIRED_HEADER ? (req.headers[REQUIRED_HEADER] as string | undefined) : undefined
    const id = req.headers['mcp-session-id'] as string | undefined
    let transport = id ? sessions.get(id) : undefined
    if (!transport) {
      if (id) return void res.writeHead(404).end()
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: (sid) => void sessions.set(sid, transport!) })
      transport.onclose = () => void (transport!.sessionId && sessions.delete(transport!.sessionId))
      await makeServer(() => lastHeader).connect(transport)
    }
    await transport.handleRequest(req, res)
  })
  const sse = new Map<string, SSEServerTransport>()
  const ssePort = flag('--sse')
  const sseServer =
    ssePort === undefined
      ? null
      : createServer(async (req, res) => {
          if (refused(req, res)) return
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          if (req.method === 'GET' && url.pathname === '/sse') {
            const transport = new SSEServerTransport('/messages', res)
            sse.set(transport.sessionId, transport)
            transport.onclose = () => void sse.delete(transport.sessionId)
            await makeServer(() => req.headers[REQUIRED_HEADER ?? ''] as string | undefined).connect(transport)
            return
          }
          if (req.method === 'POST' && url.pathname === '/messages') {
            const transport = sse.get(url.searchParams.get('sessionId') ?? '')
            if (!transport) return void res.writeHead(404).end()
            await transport.handlePostMessage(req, res)
            return
          }
          res.writeHead(405).end()
        })
  const listen = (s: ReturnType<typeof createServer>, port: number) => new Promise<number>((r) => s.listen(port, '127.0.0.1', () => r((s.address() as { port: number }).port)))
  const httpPort = await listen(http, Number(flag('--http') ?? 0))
  const ssePortBound = sseServer ? await listen(sseServer, Number(ssePort)) : null
  process.stdout.write(JSON.stringify({ http: httpPort, sse: ssePortBound }) + '\n')
}
