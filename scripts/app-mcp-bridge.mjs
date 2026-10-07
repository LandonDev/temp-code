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
import { pathToFileURL } from 'node:url'

const PORT = process.env.TEMP_CODE_PORT
const SESSION = process.env.TEMP_CODE_SESSION

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

async function appRequest(method, params, timeoutMs = 120_000) {
  const ws = await connect()
  const id = `bridge-${nextWsId++}`
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params: { sessionId: SESSION, ...params } }))
    if (timeoutMs > 0) {
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error('app server timeout'))
      }, timeoutMs)
    }
  })
}

// ── the MCP tool surface (mirrors src/main/server/apptools.ts) ───────

const PROVIDERS = ['claude', 'codex', 'cursor']

// Copies of src/shared/htmlRender.ts's descriptions (this script has no
// imports); app-bridge.test.ts keeps them equal.
const HTML_PAGE_RULES =
  'Write one self-contained document with inline <style> and <script>. Local images written as absolute file paths (src="/abs/shot.png", CSS url(/abs/bg.webp), or a JS string) are inlined automatically; remote http(s) URLs, such as a CDN chart library, load as-is.'
const HTML_RENDER_LAYOUT_GUIDE = [
  "The frame is borderless on the thread's background, as wide as the reply column (864px at full width, about 320px when the window is narrow), and its left edge lines up with your reply text.",
  "The page sits on the thread's own background, so by default leave html, body, and the outermost element with no background color. This overrides general style preferences such as a fixed black page background.",
  'Use a fluid width with no horizontal padding on the outermost element, and no outer card, border, or banner title: the page is part of your reply.',
  'If a box needs its own background (a mock of a specific screen, a panel that must stand apart), give it at least 16px of padding on every side and var(--radius) corners, so content never touches its edge.',
  'Give charts fixed pixel heights rather than heights that scale with width.',
  "Let content set the page's height. Avoid viewport-based heights such as 100vh or height:100% on html or body; the frame grows to fit the page, so they can make it grow again and again."
].join(' ')
const HTML_RENDER_THEME_GUIDE = [
  "temp-code injects its active theme as CSS custom properties on :root, and they follow the user's theme and light/dark mode live:",
  '--background (page background, identical to the thread around the frame), --foreground, --muted, --muted-foreground,',
  '--card, --card-foreground, --border, --input, --ring, --primary, --primary-foreground (solid buttons), --accent, --accent-foreground (brand accent), --link,',
  '--destructive, --warning, --success, --info, --code-background,',
  '--chart-1 … --chart-6 (categorical series for charts), --radius, --font-sans, --font-mono.',
  "The base stylesheet sets html background/color/font from these, body margin to 0, and hides the page's scrollbar; your own CSS overrides it."
].join(' ')
export const HTML_PREVIEW_TOOL_DESCRIPTION = `Render an HTML page in temp-code's hidden browser window and get back a PNG screenshot, contentHeight (the height the page needs at this width), and its console output: log, warning, error, and uncaught exceptions, with locations pointing into page.html. console.log is a fine way to report your own checks. Use it to check and iterate on a page before html_render. ${HTML_PAGE_RULES} The page gets the theme variables and layout described in html_render.`
export const HTML_RENDER_TOOL_DESCRIPTION = `Show a finished HTML page (chart, table, diagram, collage, mockup) inline in this thread, above your final text reply; call it before writing that reply. The reader already sees the page, so the reply should not announce it, say where it is, or restate it: add only what the page doesn't say. Preview with html_preview first. temp-code fits the frame to the page's height at each reader's width. A height below the page's contentHeight caps the frame there, and the rest scrolls inside it. ${HTML_PAGE_RULES} ${HTML_RENDER_LAYOUT_GUIDE} ${HTML_RENDER_THEME_GUIDE}`
const HTML_TOOL_PARAMS = {
  html: 'A complete, self-contained HTML document.',
  width:
    'Viewport width in CSS pixels, 240-1600. Defaults to 864, the reply column at full width; use about 400 to check a narrow window.',
  appearance: 'Theme to preview. Defaults to dark.',
  title: 'Short name for the page.',
  height:
    "The frame height in CSS pixels, 80-2000. Use html_preview's contentHeight, or less to make long content scroll inside the frame."
}

export const TOOLS = [
  {
    // Codex's native update_plan went away with the goal tools; the app's
    // implementation board still renders from it, so the bridge carries a
    // stand-in of the same shape. Answered locally — nothing to forward.
    name: 'update_plan',
    description:
      'Create or replace your task list for this job (the app renders it as the implementation board). Call it FIRST with every task, then again whenever a status changes: one in_progress at a time, completed the moment a task is done.',
    inputSchema: {
      type: 'object',
      properties: {
        explanation: { type: 'string' },
        plan: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              step: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }
            },
            required: ['step', 'status']
          }
        }
      },
      required: ['plan']
    }
  },
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
        context1m: {
          type: 'boolean',
          description:
            'Claude models only: run the thread with the 1M context window. Rejected for models that do not offer it.'
        },
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
  },
  // ── subagents: the ONLY way to run another model on a subtask ──────
  {
    name: 'spawn_agent',
    description:
      'Spawn a subagent session (any provider/model, freely mixed) and send it its task — the ONLY way to run another model; NEVER shell out to `claude`/`codex exec`/`cursor-agent`. The agent works asynchronously as a visible session; use wait_for_agent to collect its result.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          enum: PROVIDERS,
          description: 'Which harness runs the agent (omit to derive from the model)'
        },
        model: {
          type: 'string',
          description:
            'Model id — the full spawnable table is in your thread instructions (defaults: claude=claude-sonnet-5, codex=gpt-5.6-sol, cursor=composer-2.5). Loose names like "opus" resolve; a model of another provider auto-routes to it.'
        },
        reasoning: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
        agentType: {
          type: 'string',
          enum: ['orchestrator', 'implementer', 'reviewer', 'explorer']
        },
        task: { type: 'string', description: 'The complete, self-contained task prompt' },
        useWorktree: {
          type: 'boolean',
          description: 'Isolate a writing agent in its own git worktree (default true)'
        },
        context1m: {
          type: 'boolean',
          description:
            'Claude models only: the 1M context window, on by default for models that offer it. Pass false for 200k. true is rejected for models that do not offer it.'
        }
      },
      required: ['task']
    }
  },
  {
    name: 'send_to_agent',
    description: 'Send a follow-up message to a subagent you spawned.',
    inputSchema: {
      type: 'object',
      properties: { agentId: { type: 'string' }, message: { type: 'string' } },
      required: ['agentId', 'message']
    }
  },
  {
    name: 'check_agent',
    description:
      'Non-blocking look at what a subagent is doing right now: status, recent tool activity, latest text, anything it is stuck on, token usage.',
    inputSchema: {
      type: 'object',
      properties: { agentId: { type: 'string' } },
      required: ['agentId']
    }
  },
  {
    name: 'wait_for_agent',
    description:
      'Block until a subagent (or the first of several) finishes its current turn, then return its latest reply and status. Timeouts are normal for long tasks — check_agent, then wait again.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'One agent to wait for' },
        agentIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Several agents — with mode "any", results arrive in completion order'
        },
        mode: { type: 'string', enum: ['any', 'all'] },
        timeoutSeconds: {
          type: 'number',
          description:
            '0 / omitted = sleep until settled (the normal case — no polling). Set only to get control back early.'
        }
      }
    }
  },
  {
    name: 'answer_agent',
    description:
      'Answer a subagent\'s pending structured question (the "pending" payload from wait_for_agent/check_agent). answers[i] = chosen labels for questions[i]. Permission approvals cannot be answered this way — those belong to the user.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        requestId: { type: 'string' },
        answers: { type: 'array', items: { type: 'array', items: { type: 'string' } } }
      },
      required: ['agentId', 'requestId', 'answers']
    }
  },
  {
    name: 'interrupt_agent',
    description:
      "Stop a subagent's current turn (it stays alive and can be redirected with send_to_agent).",
    inputSchema: {
      type: 'object',
      properties: { agentId: { type: 'string' } },
      required: ['agentId']
    }
  },
  {
    name: 'list_agents',
    description: 'List the subagents of this session with their status.',
    inputSchema: { type: 'object', properties: {} }
  },
  // ── agent HTML pages ───────────────────────────────────────────────
  {
    name: 'html_preview',
    description: HTML_PREVIEW_TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        html: { type: 'string', minLength: 1, maxLength: 512000, description: HTML_TOOL_PARAMS.html },
        width: { type: 'integer', minimum: 240, maximum: 1600, description: HTML_TOOL_PARAMS.width },
        appearance: { type: 'string', enum: ['dark', 'light'], description: HTML_TOOL_PARAMS.appearance }
      },
      required: ['html']
    }
  },
  {
    name: 'html_render',
    description: HTML_RENDER_TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        html: { type: 'string', minLength: 1, maxLength: 512000, description: HTML_TOOL_PARAMS.html },
        title: { type: 'string', minLength: 1, maxLength: 200, description: HTML_TOOL_PARAMS.title },
        height: { type: 'integer', minimum: 80, maximum: 2000, description: HTML_TOOL_PARAMS.height }
      },
      required: ['html', 'title', 'height']
    }
  }
]

const METHOD_FOR = {
  app_list_threads: 'app.listThreads',
  app_read_thread: 'app.readThread',
  app_start_thread: 'app.startThread',
  spawn_agent: 'app.spawnAgent',
  send_to_agent: 'app.sendToAgent',
  check_agent: 'app.checkAgent',
  wait_for_agent: 'app.waitForAgent',
  answer_agent: 'app.answerAgent',
  interrupt_agent: 'app.interruptAgent',
  list_agents: 'app.listAgents',
  html_preview: 'app.htmlPreview',
  html_render: 'app.htmlRender'
}

/** The MCP content parts a tool result turns into (the preview's PNG rides as an image). */
export function toolContent(name, result) {
  if (name === 'html_preview' && result && typeof result === 'object' && typeof result.png === 'string') {
    const { png, ...metrics } = result
    return [
      { type: 'text', text: JSON.stringify(metrics) },
      { type: 'image', data: png, mimeType: 'image/png' }
    ]
  }
  return [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }]
}

async function callTool(name, args) {
  if (name === 'update_plan') return [{ type: 'text', text: 'task list updated' }]
  const method = METHOD_FOR[name]
  if (!method) throw new Error(`unknown tool: ${name}`)
  // wait_for_agent sleeps until the agent settles (0 = no deadline); an
  // explicit timeoutSeconds gets a small buffer on top.
  const timeoutMs =
    name === 'wait_for_agent'
      ? args?.timeoutSeconds
        ? (args.timeoutSeconds + 30) * 1000
        : 0
      : 120_000
  const result = await appRequest(method, args ?? {}, timeoutMs)
  if (name === 'app_read_thread' && result === null) {
    return [{ type: 'text', text: 'refused: unknown thread id. app_list_threads shows valid ids.' }]
  }
  return toolContent(name, result)
}

// ── stdio MCP plumbing (ndjson JSON-RPC) ─────────────────────────────

const out = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')

// Only the codex-spawned process serves stdio; a test imports the tool table.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!PORT || !SESSION) {
    console.error('app-mcp-bridge: TEMP_CODE_PORT and TEMP_CODE_SESSION are required')
    process.exit(1)
  }
  createInterface({ input: process.stdin }).on('line', (line) => {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    void handle(msg)
  })
}

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
      const content = await callTool(params?.name, params?.arguments)
      out({ id, result: { content } })
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
