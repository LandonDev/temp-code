#!/usr/bin/env node
/**
 * App-tools stdio bridge (docs/PLAN-2.md M10, cross-provider phase).
 *
 * A dependency-free MCP server over stdio (newline-delimited JSON-RPC)
 * that forwards app_list_threads / app_read_thread / app_start_thread to
 * the temp-code app's WebSocket server as app.* methods. The codex driver
 * registers it per thread via the thread/start config override:
 *
 *   TEMP_CODE_PORT     the app's WS port (localhost-only)
 *   TEMP_CODE_SESSION  the calling thread's session id
 *
 * Runs under plain node (node ≥22 has a global WebSocket client). When
 * spawned with the Electron binary, ELECTRON_RUN_AS_NODE=1 makes that
 * binary behave as node.
 */

import { createInterface } from 'node:readline'

const PORT = process.env.TEMP_CODE_PORT
const SESSION = process.env.TEMP_CODE_SESSION
if (!PORT || !SESSION) {
  console.error('app-mcp-bridge: TEMP_CODE_PORT and TEMP_CODE_SESSION are required')
  process.exit(1)
}

// ── WS client to the app server ──────────────────────────────────────

let wsReady = null
let nextWsId = 1
const pending = new Map()

function connect() {
  if (wsReady) return wsReady
  wsReady = new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`)
    ws.onopen = () => resolve(ws)
    ws.onerror = () => reject(new Error('app server unreachable'))
    ws.onclose = () => {
      wsReady = null
      for (const p of pending.values()) p.reject(new Error('app server connection closed'))
      pending.clear()
    }
    ws.onmessage = (ev) => {
      let frame
      try {
        frame = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (frame.push) return // session-meta pushes — not for us
      const p = pending.get(frame.id)
      if (!p) return
      pending.delete(frame.id)
      if (frame.ok) p.resolve(frame.result)
      else p.reject(new Error(frame.error ?? 'app server error'))
    }
  })
  return wsReady
}

async function appRequest(method, params) {
  const ws = await connect()
  const id = `bridge-${nextWsId++}`
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params: { sessionId: SESSION, ...params } }))
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error('app server timeout'))
    }, 120_000)
  })
}

// ── the MCP tool surface (mirrors src/main/server/apptools.ts) ───────

const PROVIDERS = ['claude', 'codex', 'cursor']
const TOOLS = [
  {
    name: 'app_list_threads',
    description:
      "List this project's threads in the temp-code app: id, title, type, status, model, plan file, transcript path, last activity.",
    inputSchema: {
      type: 'object',
      properties: {
        allProjects: { type: 'boolean', description: "true: every project's threads" }
      }
    }
  },
  {
    name: 'app_read_thread',
    description:
      'Read another thread as a readable digest (dialogue + one-line tool actions). Works across projects.',
    inputSchema: {
      type: 'object',
      properties: { threadId: { type: 'string' } },
      required: ['threadId']
    }
  },
  {
    name: 'app_start_thread',
    description:
      'Create a new thread in the app and send its first message — it starts working immediately, visibly. Use ONLY when the user asked for a handoff or agreed to one.',
    inputSchema: {
      type: 'object',
      properties: {
        threadType: {
          type: 'string',
          enum: ['chat', 'planning', 'implementation', 'orchestration']
        },
        provider: { type: 'string', enum: PROVIDERS },
        model: { type: 'string' },
        reasoning: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
        projectId: { type: 'string', description: "Defaults to this thread's project" },
        planPath: {
          type: 'string',
          description: 'implementation/orchestration: the plan to work from'
        },
        seedThreadIds: { type: 'array', items: { type: 'string' } },
        firstMessage: { type: 'string' },
        title: { type: 'string' }
      },
      required: ['threadType', 'provider', 'firstMessage']
    }
  }
]

const METHOD_FOR = {
  app_list_threads: 'app.listThreads',
  app_read_thread: 'app.readThread',
  app_start_thread: 'app.startThread'
}

async function callTool(name, args) {
  const method = METHOD_FOR[name]
  if (!method) throw new Error(`unknown tool: ${name}`)
  const result = await appRequest(method, args ?? {})
  if (name === 'app_read_thread' && result === null) {
    return 'refused: unknown thread id. app_list_threads shows valid ids.'
  }
  return typeof result === 'string' ? result : JSON.stringify(result)
}

// ── stdio MCP plumbing (ndjson JSON-RPC) ─────────────────────────────

const out = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  void handle(msg)
})

async function handle(msg) {
  const { id, method, params } = msg
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return
  if (id === undefined) return
  try {
    if (method === 'initialize') {
      out({
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'temp-code-app', version: '0.1.0' }
        }
      })
    } else if (method === 'ping') {
      out({ id, result: {} })
    } else if (method === 'tools/list') {
      out({ id, result: { tools: TOOLS } })
    } else if (method === 'tools/call') {
      const text = await callTool(params?.name, params?.arguments)
      out({ id, result: { content: [{ type: 'text', text }] } })
    } else {
      out({ id, error: { code: -32601, message: `method not found: ${method}` } })
    }
  } catch (err) {
    // Tool failures surface as tool results, not protocol errors — the
    // model can read and react to them.
    if (method === 'tools/call') {
      out({
        id,
        result: {
          content: [{ type: 'text', text: `error: ${err?.message ?? String(err)}` }],
          isError: true
        }
      })
    } else {
      out({ id, error: { code: -32603, message: err?.message ?? String(err) } })
    }
  }
}
