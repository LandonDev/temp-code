import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { SessionMeta } from '@shared/events'
import type { SessionRegistry } from './sessions'
import { DEFAULT_RULES, type OrchestrationRules } from '@shared/rules'
import { CATALOG } from '@shared/catalog'
import { appStartThread, bridgeMcpConfig, setAppBridge } from './apptools'
import { setOrchestrationRegistry } from './orchestration'

afterEach(() => {
  setAppBridge(null)
})

it('bridgeMcpConfig returns null with no bridge registered', () => {
  expect(bridgeMcpConfig('session-1')).toBeNull()
})

it('bridgeMcpConfig runs the script under a resolved node, with no Electron env', () => {
  setAppBridge({
    port: 4321,
    scriptPath: '/repo/scripts/app-mcp-bridge.mjs',
    command: '/usr/local/bin/node',
    env: {}
  })
  const config = bridgeMcpConfig('session-1') as {
    command: string
    args: string[]
    env: Record<string, string>
  }
  expect(config.command).toBe('/usr/local/bin/node')
  expect(config.args).toEqual(['/repo/scripts/app-mcp-bridge.mjs'])
  expect(config.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  expect(config.env.TEMP_CODE_PORT).toBe('4321')
  expect(config.env.TEMP_CODE_SESSION).toBe('session-1')
})

it('bridgeMcpConfig carries ELECTRON_RUN_AS_NODE only through the Electron fallback', () => {
  setAppBridge({
    port: 4321,
    scriptPath: '/repo/scripts/app-mcp-bridge.mjs',
    command: '/Applications/TempCode.app/Contents/MacOS/TempCode',
    env: { ELECTRON_RUN_AS_NODE: '1' }
  })
  const config = bridgeMcpConfig('session-1') as { env: Record<string, string> }
  expect(config.env.ELECTRON_RUN_AS_NODE).toBe('1')
})

// ── app_start_thread and the 1M window ───────────────────────────────

const created: Record<string, unknown>[] = []
const caller = {
  id: 'caller-1',
  provider: 'claude',
  projectId: null,
  cwd: '/tmp',
  permission: 'ask'
} as unknown as SessionMeta

/** Enough registry for appStartThread to reach create(); the real one
 *  starts a driver, which a unit test has no business doing. */
const fakeRegistry = {
  get: (id: string) => (id === caller.id ? caller : null),
  getProject: () => null,
  create: async (params: Record<string, unknown>) => {
    created.push(params)
    return { id: 'thread-1', title: 'a thread' }
  },
  send: async () => {}
} as unknown as SessionRegistry

beforeEach(() => {
  created.length = 0
})

it('app_start_thread passes context1m through on a claude model', async () => {
  const result = await appStartThread(fakeRegistry, caller, {
    threadType: 'chat',
    provider: 'claude',
    model: 'claude-opus-5',
    firstMessage: 'go',
    context1m: true
  })
  expect(result).toEqual({ threadId: 'thread-1', title: 'a thread' })
  expect(created[0].context1m).toBe(true)
})

it('app_start_thread leaves context1m unset when it was not asked for', async () => {
  await appStartThread(fakeRegistry, caller, {
    threadType: 'chat',
    provider: 'claude',
    model: 'claude-opus-5',
    firstMessage: 'go'
  })
  expect(created[0].context1m).toBeUndefined()
})

it('app_start_thread refuses context1m on a codex model and creates nothing', async () => {
  const result = await appStartThread(fakeRegistry, caller, {
    threadType: 'chat',
    provider: 'codex',
    model: 'gpt-6-astra',
    firstMessage: 'go',
    context1m: true
  })
  expect(result).toMatch(/^refused:/)
  expect(result).toContain('1M context window')
  expect(created).toHaveLength(0)
})

// ── app_start_thread follows no model policy ─────────────────────────
// A thread is a person's choice whoever starts it: the policy in
// shared/rules.ts (Fable orchestrators-only by default, a model switched
// off) governs spawn_agent alone. app_start_thread checks the catalog
// only: the model exists, the effort is on its ladder, context1m where
// offered. The orchestration module's registry is set per test so a
// policy that WOULD refuse is in force and ignored.

let callerNow: SessionMeta = caller
const asRole = (patch: Partial<SessionMeta>): SessionMeta => {
  callerNow = { ...caller, ...patch } as SessionMeta
  return callerNow
}
const policyRegistry = (rules: OrchestrationRules, masterThreadId: string | null = null) =>
  setOrchestrationRegistry({
    get: (id: string) => (id === caller.id ? callerNow : null),
    getProject: () => ({ id: 'proj', workspaceId: null, masterThreadId }),
    getOrchestrationRules: () => rules,
    effectiveReview: () => ({ settings: { beforeMerge: false } })
  } as unknown as SessionRegistry)
const policyFake = { ...fakeRegistry, get: (id: string) => (id === caller.id ? callerNow : null) } as SessionRegistry

afterEach(() => {
  callerNow = caller
  setOrchestrationRegistry(null as unknown as SessionRegistry)
})

it('app_start_thread starts an orchestrators-only model from a chat thread, at the effort asked', async () => {
  policyRegistry({ ...DEFAULT_RULES, models: { 'claude:claude-fable-5-1': { approved: 'orchestrators', maxReasoning: 'medium' } } })
  const result = await appStartThread(policyFake, asRole({ threadType: 'chat' }), {
    threadType: 'implementation',
    provider: 'claude',
    model: 'claude-fable-5-1',
    reasoning: 'high',
    firstMessage: 'go'
  })
  expect(result).toEqual({ threadId: 'thread-1', title: 'a thread' })
  expect(created[0]).toMatchObject({ model: 'claude-fable-5-1', reasoning: 'high' })
})

it('app_start_thread starts a model the user switched off for subagents, for every role', async () => {
  policyRegistry({ ...DEFAULT_RULES, models: { 'claude:claude-opus-5-5': { approved: false } } })
  for (const threadType of ['chat', 'orchestration'] as const) {
    const result = await appStartThread(policyFake, asRole({ threadType }), {
      threadType: 'chat',
      provider: 'claude',
      model: 'claude-opus-5-5',
      firstMessage: 'go'
    })
    expect(result).toEqual({ threadId: 'thread-1', title: 'a thread' })
  }
  expect(created.map((c) => c.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
})

it("app_start_thread with no model takes the provider's catalog default, whatever the policy", async () => {
  policyRegistry(DEFAULT_RULES)
  const chat = await appStartThread(policyFake, asRole({ threadType: 'chat' }), { threadType: 'chat', provider: 'claude', firstMessage: 'go' })
  expect(chat).toEqual({ threadId: 'thread-1', title: 'a thread' })
  expect(created[0]).toMatchObject({ provider: 'claude', model: CATALOG.claude.defaultModel })
})

it('app_start_thread keeps the catalog refusals: an effort off the ladder, an unknown model', async () => {
  policyRegistry(DEFAULT_RULES)
  const ladder = await appStartThread(policyFake, caller, {
    threadType: 'chat',
    provider: 'claude',
    model: 'claude-opus-5-5',
    reasoning: 'ultra',
    firstMessage: 'go'
  })
  expect(ladder).toMatch(/^refused: claude-opus-5-5 supports reasoning/)
  const unknown = await appStartThread(policyFake, caller, { threadType: 'chat', provider: 'claude', model: 'claude-nope', firstMessage: 'go' })
  expect(unknown).toMatch(/^refused: no provider serves model "claude-nope"/)
  expect(created).toHaveLength(0)
})

// ── packaging guard ──────────────────────────────────────────────────
// The bridge only works in the installed app if electron-builder ships
// the script. electron-builder's `files` defaults to everything and our
// list is all negations, so the guard is: no exclusion matches the path.

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

/** `{a,b}` → ['a', 'b'], one level, which is all the file list uses. */
function expandBraces(pattern: string): string[] {
  const match = /\{([^{}]*)\}/.exec(pattern)
  if (!match) return [pattern]
  return match[1]
    .split(',')
    .flatMap((option) =>
      expandBraces(pattern.slice(0, match.index) + option + pattern.slice(match.index + match[0].length))
    )
}

function globMatches(pattern: string, path: string): boolean {
  return expandBraces(pattern).some((glob) => {
    const source = glob
      .split('**')
      .map((part) =>
        part
          .split('*')
          .map((literal) => literal.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
          .join('[^/]*')
      )
      .join('.*')
    return new RegExp(`^${source}$`).test(path)
  })
}

function excludePatterns(): string[] {
  const lines = readFileSync(join(REPO_ROOT, 'electron-builder.yml'), 'utf8').split('\n')
  const start = lines.indexOf('files:')
  expect(start).toBeGreaterThanOrEqual(0)
  const entries: string[] = []
  for (const line of lines.slice(start + 1)) {
    const entry = /^\s+- '(.*)'$/.exec(line)
    if (!entry) break
    entries.push(entry[1])
  }
  expect(entries.length).toBeGreaterThan(0)
  // Every rule is a negation, so nothing else narrows the default include.
  expect(entries.filter((entry) => !entry.startsWith('!'))).toEqual([])
  return entries.map((entry) => entry.slice(1))
}

it('the glob matcher agrees with the exclusions it is asked to read', () => {
  expect(globMatches('src/*', 'src/main.ts')).toBe(true)
  expect(globMatches('src/*', 'scripts/app-mcp-bridge.mjs')).toBe(false)
  expect(globMatches('!**/.vscode/*'.slice(1), 'a/b/.vscode/settings.json')).toBe(true)
  expect(globMatches('{tsconfig.json,tsconfig.node.json}', 'tsconfig.node.json')).toBe(true)
})

it('electron-builder ships scripts/app-mcp-bridge.mjs', () => {
  expect(existsSync(join(REPO_ROOT, 'scripts', 'app-mcp-bridge.mjs'))).toBe(true)
  const excluded = excludePatterns().filter((pattern) =>
    globMatches(pattern, 'scripts/app-mcp-bridge.mjs')
  )
  expect(excluded).toEqual([])
})

// ── html_preview / html_render ───────────────────────────────────────

const { z } = await import('zod')
const {
  APP_TOOLS,
  HTML_PREVIEW_SHAPE,
  HTML_RENDER_SHAPE,
  htmlPreviewTool,
  htmlRenderTool
} = await import('./apptools')
const { setHtmlPreviewer, setHtmlRenderRoot } = await import('./htmlRender')
const { HTML_RENDER_SHOWN_MESSAGE } = await import('@shared/htmlRender')
const { mkdtempSync, rmSync } = await import('node:fs')
const { tmpdir } = await import('node:os')

it('APP_TOOLS lists plan_complete under the app server prefix', () => {
  expect(APP_TOOLS).toContain('mcp__app__plan_complete')
})

it('APP_TOOLS lists both html tools under the app server prefix', () => {
  expect(APP_TOOLS).toContain('mcp__app__html_preview')
  expect(APP_TOOLS).toContain('mcp__app__html_render')
})

it('the schemas reject a missing title and an out-of-range height or width', () => {
  expect(z.object(HTML_RENDER_SHAPE).safeParse({ html: '<p/>', height: 300 }).success).toBe(false)
  expect(z.object(HTML_RENDER_SHAPE).safeParse({ html: '<p/>', title: 'T', height: 5000 }).success).toBe(false)
  expect(z.object(HTML_RENDER_SHAPE).safeParse({ html: '<p/>', title: 'T', height: 300 }).success).toBe(true)
  expect(z.object(HTML_PREVIEW_SHAPE).safeParse({ html: '<p/>', width: 100 }).success).toBe(false)
  expect(z.object(HTML_PREVIEW_SHAPE).safeParse({ html: '<p/>' }).success).toBe(true)
})

it('html_preview carries the metrics as text and the screenshot as an image part', async () => {
  setHtmlPreviewer({
    preview: async () => ({
      png: 'UE5H',
      contentHeight: 420,
      capturedHeight: 420,
      consoleMessages: [{ level: 'error', text: 'Uncaught Error: boom (page.html:3)' }]
    }),
    measure: async () => []
  })
  const result = await htmlPreviewTool({ html: '<p>x</p>' })
  expect(result.isError).toBeUndefined()
  expect(result.content[1]).toEqual({ type: 'image', data: 'UE5H', mimeType: 'image/png' })
  const metrics = JSON.parse((result.content[0] as { text: string }).text)
  expect(metrics).toMatchObject({ width: 864, contentHeight: 420, capturedHeight: 420 })
  expect(metrics.png).toBeUndefined()
  expect(metrics.consoleMessages[0].text).toContain('page.html:3')
  setHtmlPreviewer(null)
})

it('html_render returns the reference with the no-restate message; an inline error is an isError result', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tc-apptools-'))
  setHtmlRenderRoot(root)
  setHtmlPreviewer({
    preview: async () => {
      throw new Error('unused')
    },
    measure: async (_html, widths) => widths.map((w) => [w, 200] as const)
  })
  const ok = await htmlRenderTool('sess-9', { html: '<p>x</p>', title: 'Chart', height: 300 })
  expect(ok.isError).toBeUndefined()
  const parsed = JSON.parse((ok.content[0] as { text: string }).text)
  expect(parsed.message).toBe(HTML_RENDER_SHOWN_MESSAGE)
  expect(parsed.htmlRender).toMatchObject({ sessionId: 'sess-9', title: 'Chart', height: 300 })
  expect(parsed.htmlRender.heights).toHaveLength(8)
  expect(existsSync(join(root, 'sess-9', `${parsed.htmlRender.pageId}.html`))).toBe(true)

  const bad = await htmlRenderTool('sess-9', {
    html: '<img src="/definitely/not/here.png">',
    title: 'Broken',
    height: 300
  })
  expect(bad.isError).toBe(true)
  expect((bad.content[0] as { text: string }).text).toContain('/definitely/not/here.png')
  setHtmlPreviewer(null)
  rmSync(root, { recursive: true, force: true })
})

// ── app_start_thread from a master (CLAUDE.md "Master threads") ──────

it('app_start_thread from a project\'s master stamps masterId and carries after', async () => {
  const master = { ...caller, id: 'master-1', projectId: 'p1' } as SessionMeta
  const registry = {
    ...fakeRegistry,
    get: (id: string) => (id === master.id ? master : null),
    getProject: (id: string) => (id === 'p1' ? { id: 'p1', cwd: '/tmp/p1', masterThreadId: 'master-1' } : null)
  } as unknown as SessionRegistry
  const result = await appStartThread(registry, master, {
    threadType: 'implementation',
    provider: 'claude',
    model: 'claude-haiku-5-5',
    firstMessage: 'build it',
    after: 'sibling-1'
  })
  expect(typeof result).toBe('object')
  expect(created[0].masterId).toBe('master-1')
  expect(created[0].after).toBe('sibling-1')
  expect(created[0].startedBy).toBe('master-1')
  expect(created[0].parentId).toBeNull()
})

it('app_start_thread from any other thread stamps no masterId and drops after', async () => {
  const other = { ...caller, id: 'other-1', projectId: 'p1' } as SessionMeta
  const registry = {
    ...fakeRegistry,
    get: (id: string) => (id === other.id ? other : null),
    getProject: (id: string) => (id === 'p1' ? { id: 'p1', cwd: '/tmp/p1', masterThreadId: 'master-1' } : null)
  } as unknown as SessionRegistry
  await appStartThread(registry, other, {
    threadType: 'chat',
    provider: 'claude',
    model: 'claude-haiku-5-5',
    firstMessage: 'go',
    after: 'sibling-1'
  })
  expect(created[0].masterId).toBeUndefined()
  expect(created[0].after).toBeUndefined()
})
