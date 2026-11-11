import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent, SessionMeta } from '@shared/events'
import type { DriverHandle } from './drivers/types'

/**
 * COMPUTER_MECHANICS reaches every thread that has the computer tools exactly
 * once (the plan's §2): claude in its system prompt (mechanicsFor on a typed
 * or orchestration thread, the driver's fallback for a subagent with no
 * thread type), codex and Muse in their first message; never a thread
 * without the tools, and never a cursor thread.
 */

vi.mock('electron', () => ({ nativeImage: {} }))
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: vi.fn()
}))
vi.mock('./drivers/binaries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./drivers/binaries')>()),
  resolveClaude: async () => ({ path: null })
}))
vi.mock('./endpoint', () => ({ routedEndpointFor: async () => ({ url: null }) }))

const sends = new Map<string, string[]>()
vi.mock('./drivers', () => {
  const driver = (id: string) => ({
    id,
    start: async (ctx: { session: SessionMeta; emit: (e: AgentEvent) => void }) => ({
      send: async (text: string) => void sends.set(ctx.session.id, [...(sends.get(ctx.session.id) ?? []), text]),
      answer: () => true,
      approve: () => true,
      interrupt: () => {},
      dispose: async () => {}
    })
  })
  return { BUILT_IN_DRIVERS: { claude: driver('claude'), codex: driver('codex'), muse: driver('muse'), cursor: driver('cursor') } }
})

const { claudeDriver } = await import('./drivers/claude')
const { computerHooks } = await import('./computer/mcp')
const { computerTools } = await import('./computer/mcp')
const { offersComputerTools, setAppBridge } = await import('./apptools')
const { mechanicsFor, setOrchestrationRegistry } = await import('./orchestration')
const { openDb, Store } = await import('./db')
const { SessionRegistry } = await import('./sessions')
const { cancelMirrors } = await import('./mirror')

const HEADING = '## Computer use'
const count = (text: string | undefined): number => (text ?? '').split(HEADING).length - 1

const available = { current: true }
function mac(): void {
  computerHooks.current = { available: () => available.current } as unknown as NonNullable<typeof computerHooks.current>
}

const handles: DriverHandle[] = []
beforeEach(() => {
  available.current = true
  mac()
  setAppBridge({ port: 1, scriptPath: '/bridge.mjs', command: 'node', env: {} })
})
afterEach(async () => {
  for (const h of handles.splice(0)) await h.dispose()
  computerHooks.current = null
  setAppBridge(null)
})

// ── claude: the system prompt ───────────────────────────────────────────

const claudeSession = (over: Partial<SessionMeta>): SessionMeta =>
  ({ id: 'c-1', provider: 'claude', cwd: '/repo', model: 'claude-opus-5-5', reasoning: 'high', permission: 'safe', context1m: false, nativeId: null, parentId: null, ...over }) as SessionMeta

async function systemPromptOf(over: Partial<SessionMeta>): Promise<string> {
  vi.mocked(query).mockImplementation(({ prompt }) => (async function* () {
    if (typeof prompt !== 'string') for await (const _message of prompt) { /* no CLI output */ }
  })() as ReturnType<typeof query>)
  const handle = await claudeDriver.start({ session: claudeSession(over), emit: () => {}, setNativeId: () => {}, requestApproval: async () => false })
  handles.push(handle)
  const sp = vi.mocked(query).mock.calls.at(-1)![0].options!.systemPrompt
  return typeof sp === 'object' && sp && 'append' in sp ? (sp.append ?? '') : ''
}

const CLAUDE_KINDS: [string, Partial<SessionMeta>][] = [
  ['a typed root', { threadType: 'implementation' }],
  ['a chat', { threadType: 'chat' }],
  ['an orchestration thread', { threadType: 'orchestration', agentType: 'orchestrator' }],
  ['an implementer subagent', { parentId: 'p', agentType: 'implementer' }],
  ['an explorer subagent', { parentId: 'p', agentType: 'explorer' }],
  ['a reviewer subagent', { parentId: 'p', agentType: 'reviewer' }]
]

describe('claude reads it once, in its system prompt', () => {
  for (const [name, over] of CLAUDE_KINDS)
    it(name, async () => {
      expect(count(await systemPromptOf(over))).toBe(1)
    })

  it('a subagent reads the stricter provenance line', async () => {
    expect(await systemPromptOf({ parentId: 'p', agentType: 'implementer' })).toContain('it pre-approves nothing')
  })

  it('and nowhere when computer use is unavailable', async () => {
    available.current = false
    for (const [, over] of CLAUDE_KINDS) expect(count(await systemPromptOf(over))).toBe(0)
  })

  it('mechanicsFor leaves it out for a codex session, which reads it in its first message', () => {
    expect(count(mechanicsFor(claudeSession({ provider: 'codex', model: 'gpt-6.1-sol' })))).toBe(0)
    expect(count(mechanicsFor(claudeSession({})))).toBe(1)
  })
})

// ── codex, Muse and cursor: the first message ───────────────────────────

let root: string
let db: ReturnType<typeof openDb>
let registry: InstanceType<typeof SessionRegistry>

describe('codex and Muse read it once, in their first message', () => {
  beforeEach(async () => {
    sends.clear()
    root = await mkdtemp(join(tmpdir(), 'tc-computer-prompt-'))
    db = openDb(join(root, 'test.db'))
    const store = new Store(db)
    registry = new SessionRegistry(store)
    setOrchestrationRegistry(registry)
    const ws = join(root, 'repo')
    await mkdir(ws)
    store.insertWorkspace({ id: 'ws1', name: 'repo', path: ws, git: false, createdAt: 1 })
    store.insertProject({ id: 'p1', workspaceId: 'ws1', name: 'app', mode: 'local', branch: null, cwd: ws, archived: false, createdAt: 1 })
  })
  afterEach(async () => {
    await registry.close()
    cancelMirrors()
    db.close()
    await rm(root, { recursive: true, force: true })
  })

  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20))

  async function firstMessage(params: Record<string, unknown>): Promise<string> {
    const s = await registry.create({ projectId: 'p1', ...params } as Parameters<typeof registry.create>[0])
    await registry.send(s.id, 'do it')
    await flush()
    return sends.get(s.id)?.[0] ?? ''
  }

  const KINDS: [string, Record<string, unknown>][] = [
    ['a typed root', { threadType: 'implementation' }],
    ['an orchestration thread', { threadType: 'orchestration', agentType: 'orchestrator' }],
    ['an implementer subagent', { agentType: 'implementer', parent: true }],
    ['an explorer subagent', { agentType: 'explorer', parent: true }],
    ['a reviewer subagent', { agentType: 'reviewer', parent: true }]
  ]

  for (const provider of ['codex', 'muse'] as const)
    for (const [name, k] of KINDS)
      it(`${provider}: ${name}`, async () => {
        const { parent, ...rest } = k
        const parentId = parent ? (await registry.create({ projectId: 'p1', threadType: 'implementation', provider: 'claude' })).id : undefined
        const model = provider === 'codex' ? 'gpt-6.1-sol' : 'muse-wonder-1.0'
        const text = await firstMessage({ ...rest, provider, model, ...(parentId ? { parentId } : {}) })
        expect(count(text), text.slice(0, 200)).toBe(1)
        expect(text).toContain(provider === 'codex' ? 'getAXState' : 'computer_act, computer_batch and computer_result')
        expect(text).toContain(provider === 'codex' ? 'computer_result reads a call that answered "Held"' : 'Five app tools')
        expect(text).not.toContain('tool search (query "computer")')
      })

  it('claude carries none in its first message', async () => {
    expect(count(await firstMessage({ threadType: 'implementation', provider: 'claude' }))).toBe(0)
  })

  it('a cursor thread on an available Mac gets neither the section nor the tools', async () => {
    expect(count(await firstMessage({ threadType: 'implementation', provider: 'cursor', model: 'composer-2.5' }))).toBe(0)
    expect(offersComputerTools({ provider: 'cursor' })).toBe(false)
  })

  it('codex without the bridge, or a host without computer use, gets none', async () => {
    setAppBridge(null)
    expect(count(await firstMessage({ threadType: 'implementation', provider: 'codex', model: 'gpt-6.1-sol' }))).toBe(0)
    setAppBridge({ port: 1, scriptPath: '/bridge.mjs', command: 'node', env: {} })
    available.current = false
    expect(count(await firstMessage({ threadType: 'implementation', provider: 'codex', model: 'gpt-6.1-sol' }))).toBe(0)
    expect(computerTools(claudeSession({}))).toEqual([])
  })
})
