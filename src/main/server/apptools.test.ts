import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { SessionMeta } from '@shared/events'
import type { SessionRegistry } from './sessions'
import { appStartThread, bridgeMcpConfig, setAppBridge } from './apptools'

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
