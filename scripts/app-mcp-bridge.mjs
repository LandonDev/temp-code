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
 *   TEMP_CODE_MAC_TOKEN  set only when the thread's Mac bridge is on: the
 *                      mac_* tools are listed and each call carries it
 *                      (src/main/server/macTools.ts, docs/box.md)
 *   TEMP_CODE_MAC_HOME   the Mac's home directory when the box has heard it,
 *                      named in the mac_* tools' descriptions
 *
 * Runs under plain node (node ≥22 has a global WebSocket client). When
 * spawned with the Electron binary, ELECTRON_RUN_AS_NODE=1 makes that
 * binary behave as node.
 */

import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

const PORT = process.env.TEMP_CODE_PORT
const SESSION = process.env.TEMP_CODE_SESSION
const MAC_TOKEN = process.env.TEMP_CODE_MAC_TOKEN
const MAC_HOME = process.env.TEMP_CODE_MAC_HOME

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

// Copies of src/shared/research.ts (the bridge has no imports); app-bridge.test.ts keeps them equal.
const CITE_TOOL_DESCRIPTION =
  'Record a citation on the research board: the page or file you read and the one-line claim it supports. Call it after reading a source that supports a finding — that is how the board shows evidence beside each source. Only available inside a research thread and its subagents.'
const CITE_TOOL_PARAMS = {
  url: 'The source: a public http(s) URL, or the path of a file in this repository.',
  claim: 'One line: the finding this source supports, specific enough to stand alone (a figure, a name, a date, a quote).',
  title: "The page's title, when you know it."
}

/** The host field a single spawn_agent and app_start_thread take (orchestration.ts HOST_PARAM_DESCRIPTION). */
const HOST_PARAM = {
  type: 'string',
  description:
    "Which host runs it: omit for this machine; `mac` for this thread's Mac (or the only Mac linked), or a host's environment id. Use a Mac host for anything that needs Xcode, the iOS simulator, a Mac app, or files that live on the Mac: the thread runs there, as an ordinary thread the Mac app shows under This Mac, and its agent id comes back as `<host>:<id>` so every later call reaches it."
}

/** Fields a single spawn_agent and each batch entry share. */
const SPAWN_SPEC = {
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
  useWorktree: {
    type: 'boolean',
    description: 'Isolate a writing agent in its own git worktree (default true)'
  },
  context1m: {
    type: 'boolean',
    description:
      'Claude models only: the 1M context window, on by default for models that offer it. Pass false for 200k. true is rejected for models that do not offer it.'
  }
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
      'Read another thread as a readable digest (dialogue + one-line tool actions). Works across projects, and for a `<host>:<id>` thread this one started or spawned on another host.',
    inputSchema: {
      type: 'object',
      properties: { threadId: { type: 'string' } },
      required: ['threadId']
    }
  },
  {
    name: 'plan_complete',
    description:
      'Planning and project-plan threads only: say the plan is COMPLETE — the plan file is fully written and every decision is settled. Call it once, as the last tool call before your closing message. For an ordinary plan the app then starts the implementation thread itself (when auto-start is on) and tells whoever started this plan; a project plan gets `status: complete` and the user picks the next milestone from its options — nothing starts on its own. Refused while the plan file is missing or empty.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One line on what the plan covers (optional)' }
      }
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
          enum: ['chat', 'planning', 'project-plan', 'implementation', 'orchestration', 'research']
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
        environmentId: HOST_PARAM,
        planPath: {
          type: 'string',
          description:
            'implementation/orchestration: the plan to work from (research threads mint their own report path — leave it out)'
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
      'Spawn a subagent session (any provider/model, freely mixed) and send it its task — the ONLY way to run another model; NEVER shell out to `claude`/`codex exec`/`cursor-agent`. The agent works asynchronously as a visible session; use wait_for_agent to collect its result. To fan out, pass `agents` (up to 16 entries, each with its own task) instead of `task`: one call starts the whole batch and returns every agent id; top-level fields are defaults each entry may override.',
    inputSchema: {
      type: 'object',
      properties: {
        ...SPAWN_SPEC,
        environmentId: HOST_PARAM,
        task: {
          type: 'string',
          description: 'The complete, self-contained task prompt (one agent; omit when passing agents)'
        },
        agents: {
          type: 'array',
          maxItems: 16,
          description:
            'A batch of up to 16 agents started by this one call. Each entry takes the same fields as a single spawn; unset ones fall back to the top-level values.',
          items: {
            type: 'object',
            properties: {
              ...SPAWN_SPEC,
              task: { type: 'string', description: "This agent's task" }
            },
            required: ['task']
          }
        }
      }
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
      'Answer a subagent\'s pending structured question (the "pending" payload from wait_for_agent/check_agent). answers[i] = chosen labels for questions[i]. A local agent\'s permission approvals belong to the user; an agent on another host (a `<host>:<id>` agent id) takes `allow` for its approval, since that thread runs under this one\'s grant there.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        requestId: { type: 'string' },
        answers: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
        allow: { type: 'boolean', description: 'An approval on another host: true allows, false denies' }
      },
      required: ['agentId', 'requestId']
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
    description: 'List the subagents of this session with their status (those on other hosts carry host and a `<host>:<id>` agent id).',
    inputSchema: { type: 'object', properties: {} }
  },
  // ── agent HTML pages ───────────────────────────────────────────────
  {
    // A copy of src/shared/notes.ts's UPDATE_NOTES_DESCRIPTION and
    // UPDATE_NOTES_PARAMS; app-bridge.test.ts keeps them equal.
    name: 'update_notes',
    description:
      "Update this thread's working notes: the one document that survives a context compaction and seeds any successor thread. Replace or append ONE section (Goal, Decisions, State, Pointers, Open questions); the app writes notes.md beside the thread's attachments and shows it live in the Notes panel. Keep State current (what is done, in flight, blocked) and Pointers concrete (files, commands, ids). Update after every decision, before context runs low, and after a commit or merge.",
    inputSchema: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          description:
            'Which heading: Goal | Decisions | State | Pointers | Open questions (a new heading is allowed, after the fixed ones).'
        },
        mode: {
          type: 'string',
          enum: ['replace', 'append'],
          description: 'replace (default) swaps the section body; append adds a paragraph under it.'
        },
        content: { type: 'string', description: 'Markdown for the section: short lines, concrete names, no transcript.' }
      },
      required: ['section', 'content']
    }
  },
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
  // ── merge before review (src/shared/review.ts; app-bridge.test.ts keeps these equal) ──
  {
    name: 'merge_branch',
    description:
      "Land this thread's branch on the project branch: a fast-forward merge in the project checkout, then a push when the repo has an origin. When the project reviews before merge, a second model reviews the branch's diff first and this call answers with the verdict: merged, or HELD with the findings to address before calling again (a head that already passed is not reviewed twice). Call it when your gate is green instead of running git merge or git push yourself; a refusal names what to fix (not a fast-forward: rebase onto the target and call again).",
    inputSchema: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: "The branch to merge. Defaults to the branch this thread's directory is on." },
        push: { type: 'boolean', description: 'Push the project branch to origin after the merge. Defaults to true when the repo has an origin.' }
      }
    }
  },
  {
    name: 'report_findings',
    description:
      'Report the findings of a merge review as a typed list, once, when the review is done: every defect with its file, 1-indexed line, one-sentence summary, the concrete failure scenario and a verdict (CONFIRMED when you verified it against the code, PLAUSIBLE when you could not). An empty list means the change is sound. Only this call counts; prose in your reply is not read. Available only to the reviewer thread of a merge review.',
    inputSchema: {
      type: 'object',
      properties: {
        findings: {
          type: 'array',
          maxItems: 32,
          description: 'Verified findings, most severe first; empty if none survived',
          items: {
            type: 'object',
            properties: {
              file: { type: 'string', description: 'Repo-relative path of the file the finding is in' },
              line: { type: 'integer', description: '1-indexed line the finding anchors to' },
              summary: { type: 'string', description: 'One-sentence statement of the defect' },
              failure_scenario: { type: 'string', description: 'Concrete inputs/state → wrong output/crash' },
              verdict: { type: 'string', enum: ['CONFIRMED', 'PLAUSIBLE'], description: 'CONFIRMED when verified against the code, PLAUSIBLE when not' },
              category: { type: 'string', maxLength: 40, description: 'Short kebab-case slug of the finding type, e.g. "correctness"' },
              short_summary: { type: 'string', maxLength: 60, description: 'Compressed label (≤60 chars): the claim alone' }
            },
            required: ['file', 'summary', 'failure_scenario']
          }
        },
        level: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'], description: 'Effort level the review ran at' }
      },
      required: ['findings']
    }
  },
  // ── citations (research threads) ───────────────────────────────────
  {
    name: 'cite_source',
    description: CITE_TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', minLength: 1, maxLength: 2000, description: CITE_TOOL_PARAMS.url },
        claim: { type: 'string', minLength: 1, maxLength: 300, description: CITE_TOOL_PARAMS.claim },
        title: { type: 'string', maxLength: 300, description: CITE_TOOL_PARAMS.title }
      },
      required: ['url', 'claim']
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

// Interactive jobs (mac_run background: true): copies of src/shared/contract-macjobs.ts's
// MAC_JOB_TOOL_DESCRIPTIONS and MAC_JOB_TOOL_PARAMS; macJobs.test.ts keeps them equal.
const MAC_JOB_TOOL_DESCRIPTIONS = {
  mac_job_write:
    "Write to the stdin of a job started with mac_run background: true (answer a prompt, feed input). Add a newline to send a line. close: true closes its stdin after the write (in a terminal that is end-of-file, ^D). No new approval: the user allowed the job when it started.",
  mac_job_read:
    'Read the output of a job started with mac_run background: true: what it wrote past afterOffset (pass the last nextOffset), at most the newest 1 MiB, plus whether it is still running and its exit code once done. waitMs waits for new output or the exit. A job with no read or write for 30 minutes is killed.',
  mac_job_signal:
    'Send a signal to a job started with mac_run background: true: INT (like Ctrl-C), TERM, or KILL. It goes to the whole process group.'
}
const MAC_JOB_TOOL_PARAMS = {
  background:
    'Start it as an interactive job instead: it runs in a terminal on the Mac with stdin open, and this answers {jobId} at once. Then use mac_job_read, mac_job_write and mac_job_signal. The user still approves it first. At most 4 jobs per thread; a job ends with the thread or after 30 idle minutes.',
  jobId: 'The jobId mac_run background: true answered.',
  text: 'Text to write to the job\'s stdin, as UTF-8 (include "\\n" to end a line).',
  dataBase64: 'Raw bytes to write instead of text, base64.',
  close: "Close the job's stdin after this write.",
  afterOffset: "Read output past this byte offset: the last read's nextOffset (default 0).",
  waitMs: 'Wait up to this many milliseconds for new output or the exit (default 0, at most 30000).',
  signal: 'INT, TERM or KILL.'
}

// ── the Mac bridge (only when TEMP_CODE_MAC_TOKEN is set) ────────────
// Copies of src/shared/contract-macbridge.ts's MAC_TOOL_DESCRIPTIONS,
// macToolDescriptions and MAC_TOOL_PARAMS; macTools.test.ts keeps them equal.
const MAC_TOOL_DESCRIPTIONS = {
  mac_read_file:
    "Read a file on the user's Mac (this thread runs on a remote host; the Mac is where the user and their files are). Paths are absolute Mac paths, or start with ~ for the Mac's home. Folders the user shared with this host read at once (with full access, any path but keys and credentials); any other path waits for the user to allow it on the Mac, and may be denied.",
  mac_list_dir:
    "List a folder on the user's Mac: name, kind, size and modification time of each entry. Paths are absolute Mac paths, or start with ~ for the Mac's home. Folders the user shared read at once (with full access, any path but keys and credentials); others wait for the user's approval on the Mac.",
  mac_fetch_file:
    "Copy a file from the user's Mac onto this host and get back the local path it landed at (inside this thread's .temp-code/attachments folder). Use it for files you need to work on here (up to 64 MiB). The same approval rules as mac_read_file.",
  mac_run:
    "Run a command on the user's Mac (for macOS-only tools: xcodebuild, osascript, open, security, …). Every command waits for the user to allow it on the Mac, showing them exactly the argv and cwd, and may be denied. Runs through the Mac's login shell with no stdin; the output streams into this call's row while it runs and comes back whole up to 4 MiB (past that, the first 1 MiB and the last 3 MiB). Prefer argv; use command only when you need shell syntax (pipes, globs).",
  mac_write_file:
    "Write a file on the user's Mac (up to 8 MiB). Give the contents as text (a UTF-8 string, for source, config and other text files) or as dataBase64 (any bytes), exactly one of them. Paths are absolute Mac paths. mode create (the default) refuses a file that exists, overwrite replaces it atomically, append adds to its end. Folders the user shared with this host take writes at once when the user allows commands too; any other path, anything under ~/Library and the dotfiles in the Mac's home wait for the user to allow it on the Mac, and may be denied."
}
const MAC_TOOL_PARAMS = {
  path: "Absolute path on the Mac, or ~/… for the Mac's home, e.g. ~/Documents/report.pdf.",
  maxBytes: 'Read at most this many bytes (default 262144, at most 8388608).',
  argv: 'The command and its arguments, run as given with no shell parsing, e.g. ["xcrun", "simctl", "list"].',
  command: "A shell command line instead of argv, read by the Mac's login shell.",
  cwd: "Absolute working directory on the Mac, or ~/… (default: the Mac's home directory).",
  timeoutMs: 'Kill the command after this many milliseconds (default 120000, at most 1800000).',
  dataBase64: "The file's bytes, base64-encoded (at most 8 MiB decoded). Give this or text, not both.",
  text: "The file's contents as a UTF-8 string (at most 8 MiB once encoded). Give this or dataBase64, not both.",
  mode: 'create (default: fails if the file exists), overwrite, or append.',
  fileMode: 'Unix permission bits as a decimal number, e.g. 420 for 0644 (default: 0644 for a new file, unchanged for an existing one).'
}
/** The descriptions for one thread: the Mac's home named when the box knows it (TEMP_CODE_MAC_HOME). */
export function macToolDescriptions(home) {
  const note = home ? ` The Mac's home is ${home} (~ means it: ~/Desktop is ${home}/Desktop).` : ''
  return Object.fromEntries(Object.entries(MAC_TOOL_DESCRIPTIONS).map(([k, v]) => [k, v + note]))
}
const macPath = { type: 'string', description: MAC_TOOL_PARAMS.path }
/** The four tools as this thread lists them. */
export function macTools(home = MAC_HOME) {
  const d = macToolDescriptions(home)
  return [
    {
      name: 'mac_read_file',
      description: d.mac_read_file,
      inputSchema: {
        type: 'object',
        properties: { path: macPath, maxBytes: { type: 'integer', minimum: 1, maximum: 8388608, description: MAC_TOOL_PARAMS.maxBytes } },
        required: ['path']
      }
    },
    { name: 'mac_list_dir', description: d.mac_list_dir, inputSchema: { type: 'object', properties: { path: macPath }, required: ['path'] } },
    { name: 'mac_fetch_file', description: d.mac_fetch_file, inputSchema: { type: 'object', properties: { path: macPath }, required: ['path'] } },
    {
      name: 'mac_run',
      description: d.mac_run,
      inputSchema: {
        type: 'object',
        properties: {
          background: { type: 'boolean', description: MAC_JOB_TOOL_PARAMS.background },
          argv: { type: 'array', items: { type: 'string' }, minItems: 1, description: MAC_TOOL_PARAMS.argv },
          command: { type: 'string', description: MAC_TOOL_PARAMS.command },
          cwd: { type: 'string', description: MAC_TOOL_PARAMS.cwd },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 1800000, description: MAC_TOOL_PARAMS.timeoutMs }
        }
      }
    },
    {
      name: 'mac_write_file',
      description: d.mac_write_file,
      inputSchema: {
        type: 'object',
        properties: {
          path: macPath,
          dataBase64: { type: 'string', description: MAC_TOOL_PARAMS.dataBase64 },
          text: { type: 'string', description: MAC_TOOL_PARAMS.text },
          mode: { type: 'string', enum: ['create', 'overwrite', 'append'], description: MAC_TOOL_PARAMS.mode },
          fileMode: { type: 'integer', minimum: 0, maximum: 511, description: MAC_TOOL_PARAMS.fileMode }
        },
        required: ['path']
      }
    }
  ]
}
export const MAC_TOOLS = macTools()
const MAC_METHOD_FOR = {
  mac_read_file: 'mac.readFile',
  mac_list_dir: 'mac.listDir',
  mac_fetch_file: 'mac.fetchFile',
  mac_run: 'mac.run',
  mac_write_file: 'mac.writeFile'
}

const macJobId = { type: 'string', description: MAC_JOB_TOOL_PARAMS.jobId }
export const MAC_JOB_TOOLS = [
  {
    name: 'mac_job_write',
    description: MAC_JOB_TOOL_DESCRIPTIONS.mac_job_write,
    inputSchema: {
      type: 'object',
      properties: {
        jobId: macJobId,
        text: { type: 'string', description: MAC_JOB_TOOL_PARAMS.text },
        dataBase64: { type: 'string', description: MAC_JOB_TOOL_PARAMS.dataBase64 },
        close: { type: 'boolean', description: MAC_JOB_TOOL_PARAMS.close }
      },
      required: ['jobId']
    }
  },
  {
    name: 'mac_job_read',
    description: MAC_JOB_TOOL_DESCRIPTIONS.mac_job_read,
    inputSchema: {
      type: 'object',
      properties: {
        jobId: macJobId,
        afterOffset: { type: 'integer', minimum: 0, description: MAC_JOB_TOOL_PARAMS.afterOffset },
        waitMs: { type: 'integer', minimum: 0, maximum: 30000, description: MAC_JOB_TOOL_PARAMS.waitMs }
      },
      required: ['jobId']
    }
  },
  {
    name: 'mac_job_signal',
    description: MAC_JOB_TOOL_DESCRIPTIONS.mac_job_signal,
    inputSchema: {
      type: 'object',
      properties: {
        jobId: macJobId,
        signal: { type: 'string', enum: ['TERM', 'KILL', 'INT'], description: MAC_JOB_TOOL_PARAMS.signal }
      },
      required: ['jobId', 'signal']
    }
  }
]

/** One mac_job_* call as the box's mac.job* methods (macTools.ts runJobTool does the same for Claude). */
export async function runJobTool(name, args, call) {
  const jobId = args?.jobId
  if (name === 'mac_job_write') {
    const hasText = typeof args?.text === 'string'
    const hasData = typeof args?.dataBase64 === 'string'
    if (hasText && hasData) throw new Error('mac_job_write takes text or dataBase64, not both')
    if (!hasText && !hasData && args?.close !== true) throw new Error('mac_job_write needs text, dataBase64 or close: true')
    const out = { jobId }
    if (hasText || hasData) {
      const dataBase64 = hasText ? Buffer.from(args.text, 'utf8').toString('base64') : args.dataBase64
      Object.assign(out, await call('mac.jobWrite', { jobId, dataBase64 }))
    }
    if (args?.close === true) Object.assign(out, await call('mac.jobClose', { jobId }))
    return out
  }
  if (name === 'mac_job_read') {
    return call('mac.jobRead', {
      jobId,
      ...(args?.afterOffset !== undefined ? { afterOffset: args.afterOffset } : {}),
      ...(args?.waitMs !== undefined ? { waitMs: args.waitMs } : {})
    })
  }
  if (name === 'mac_job_signal') return call('mac.jobSignal', { jobId, signal: args?.signal })
  throw new Error(`unknown tool: ${name}`)
}

/** The tools this thread lists: the Mac's only while its bridge is on. */
export function listedTools(macToken = MAC_TOKEN) {
  return macToken ? [...TOOLS, ...MAC_TOOLS, ...MAC_JOB_TOOLS] : TOOLS
}

const METHOD_FOR = {
  app_list_threads: 'app.listThreads',
  app_read_thread: 'app.readThread',
  app_start_thread: 'app.startThread',
  plan_complete: 'app.planComplete',
  spawn_agent: 'app.spawnAgent',
  send_to_agent: 'app.sendToAgent',
  check_agent: 'app.checkAgent',
  wait_for_agent: 'app.waitForAgent',
  answer_agent: 'app.answerAgent',
  interrupt_agent: 'app.interruptAgent',
  list_agents: 'app.listAgents',
  html_preview: 'app.htmlPreview',
  html_render: 'app.htmlRender',
  cite_source: 'app.citeSource',
  update_notes: 'app.updateNotes',
  merge_branch: 'app.mergeBranch',
  report_findings: 'app.reportFindings'
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
  // The Mac decides how long a call may wait (its approval, the command's
  // timeout); the server holds the deadline, so no client timeout here.
  if (MAC_JOB_TOOLS.some((t) => t.name === name)) {
    if (!MAC_TOKEN) throw new Error('the Mac bridge is off for this thread')
    const result = await runJobTool(name, args, (method, params) =>
      appRequest(method, { ...params, token: MAC_TOKEN }, 0)
    )
    return toolContent(name, result)
  }
  if (MAC_METHOD_FOR[name]) {
    if (!MAC_TOKEN) throw new Error('the Mac bridge is off for this thread')
    return toolContent(name, await appRequest(MAC_METHOD_FOR[name], { ...(args ?? {}), token: MAC_TOKEN }, 0))
  }
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
      out({ id, result: { tools: listedTools() } })
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
