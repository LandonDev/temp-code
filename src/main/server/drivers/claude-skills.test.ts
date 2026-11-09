import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SessionMeta } from '@shared/events'
import type { DriverHandle } from './types'

vi.mock('electron', () => ({ nativeImage: {} }))
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: vi.fn()
}))
vi.mock('./binaries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./binaries')>()),
  resolveClaude: async () => ({ path: null })
}))
let endpointUrl: string | null = null
vi.mock('../endpoint', () => ({ routedEndpointFor: async () => ({ url: endpointUrl }) }))
/** The generation the next spawn reports it loaded (a warm process's own, when adopted). */
let spawnGeneration: string | null = null
const spawned: { env: Record<string, string | undefined>; args: string[] }[] = []
vi.mock('./claudeWarm', () => ({
  spawnOrAdoptClaude: (spec: { env: Record<string, string | undefined>; args: string[] }) => {
    spawned.push(spec)
    const proc = Object.assign(new EventEmitter(), { exitCode: null, killed: false, pid: 4242, kill: () => true })
    return { proc, warmId: null, skillsGeneration: spawnGeneration }
  }
}))

const { claudeDriver } = await import('./claude')
const { configureClaudeSkillRoots, CLAUDE_ROOTS } = await import('../skills/claudeRoots')
const { workspaceOfThread } = await import('../skills/views')

/**
 * The claude driver and the skills store (plan-JBpcLz-eGMhp.md §2): every
 * thread runs under its scope's owned config dir, a routed Anthropic row
 * holds the placeholder login, and a live CLI re-reads its skills at the
 * first send after its scope's pointer moved.
 */

let tmp: string
let root: string
let current: string
let scopes: (string | null)[]
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR
const handles: DriverHandle[] = []

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'tc-claude-skills-')))
  root = join(tmp, 'harness')
  process.env.CLAUDE_CONFIG_DIR = join(tmp, 'person')
  current = join(root, 'claude', 'global@aaaaaaaaaaaa')
  spawnGeneration = current
  scopes = []
  spawned.length = 0
  endpointUrl = null
  configureClaudeSkillRoots({
    scopeOf: (s) => {
      const ws = workspaceOfThread(s, [{ id: 'w1', path: '/work' }], [{ id: 'p7', workspaceId: 'w7', cwd: '/elsewhere/p7' }])
      scopes.push(ws)
      return ws
    },
    root,
    log: () => {},
    pointers: {
      path: (_p, ws) => join(root, 'claude', 'scope', ws ? `ws-${ws}` : 'global'),
      current: () => ({ generation: current, movedAt: 0 }),
      onMoved: () => () => {}
    }
  })
})
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.dispose()
  configureClaudeSkillRoots(null)
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  rmSync(tmp, { recursive: true, force: true })
})

const session = (over: Partial<SessionMeta> = {}): SessionMeta =>
  ({ id: 'sk-1', provider: 'claude', cwd: '/repo', model: 'claude-opus-5-5', reasoning: 'high', permission: 'safe', context1m: false, nativeId: null, workspaceId: null, projectId: null, ...over }) as SessionMeta

const result = { type: 'result', subtype: 'success', total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } } as unknown as SDKMessage
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** A started handle over a query that spawns once, takes every pushed message, and yields what the test feeds it. */
async function start(over: Partial<SessionMeta> = {}, reload: () => Promise<unknown> = async () => ({ skills: [] })) {
  const pushed: unknown[] = []
  let feed: (m: SDKMessage) => void = () => {}
  const reloadSkills = vi.fn(reload)
  vi.mocked(query).mockImplementation(({ prompt, options }) => {
    options!.spawnClaudeCodeProcess!({ command: 'claude', args: ['--model', 'x'], cwd: '/repo', env: options!.env ?? {} } as never)
    const queue: SDKMessage[] = []
    let wake: (() => void) | null = null
    feed = (m) => {
      queue.push(m)
      wake?.()
    }
    if (typeof prompt !== 'string') void (async () => { for await (const m of prompt) pushed.push(m) })()
    const stream = (async function* () {
      for (;;) {
        while (queue.length) yield queue.shift()!
        await new Promise<void>((resolve) => (wake = resolve))
      }
    })()
    return Object.assign(stream, { reloadSkills, interrupt: async () => {}, getContextUsage: async () => ({}) }) as unknown as ReturnType<typeof query>
  })
  const handle = await claudeDriver.start({ session: session(over), emit: () => {}, setNativeId: () => {}, requestApproval: async () => false })
  handles.push(handle)
  const options = vi.mocked(query).mock.calls.at(-1)![0].options!
  /** One turn: the send, then its result, so the next send is no steer. */
  const turn = async (text: string): Promise<void> => {
    await handle.send(text)
    feed(result)
    await tick()
  }
  return { handle, options, reloadSkills, pushed, turn, feed }
}

it('every thread runs under its scope\'s owned root; a routed Anthropic row holds the placeholder login', async () => {
  endpointUrl = 'http://127.0.0.1:9/claude/~t=sk-1;a=home'
  const { options } = await start()
  expect(options.env?.CLAUDE_CONFIG_DIR).toBe(join(root, CLAUDE_ROOTS, 'global'))
  expect(options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('routed')
  expect(spawned.at(-1)!.env.CLAUDE_CONFIG_DIR).toBe(join(root, CLAUDE_ROOTS, 'global'))
  // No plugin route: no plugins option, no plugin path in the argv.
  expect(options.plugins).toBeUndefined()
  expect(JSON.stringify(options.extraArgs ?? {})).not.toContain('plugin')
})

it('a Meta row keeps its token mode under the owned root', async () => {
  endpointUrl = 'http://127.0.0.1:9/claude/~t=sk-2;a=meta'
  const { options } = await start({ id: 'sk-2', model: 'muse-wonder-1.0' })
  expect(options.env?.CLAUDE_CONFIG_DIR).toBe(join(root, CLAUDE_ROOTS, 'global'))
  expect(options.env?.ANTHROPIC_AUTH_TOKEN).toBe('routed')
  expect(options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(process.env.CLAUDE_CODE_OAUTH_TOKEN)
})

it('a thread with no route still gets the owned root, and no placeholder', async () => {
  const { options } = await start({ id: 'sk-3' })
  expect(options.env?.CLAUDE_CONFIG_DIR).toBe(join(root, CLAUDE_ROOTS, 'global'))
  expect(options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(process.env.CLAUDE_CODE_OAUTH_TOKEN)
})

it('the scope is workspaceOfThread of the thread itself', async () => {
  const { options } = await start({ id: 'sk-4', projectId: 'p7', cwd: '/elsewhere/p7' })
  expect(scopes).toEqual(['w7'])
  expect(options.env?.CLAUDE_CONFIG_DIR).toBe(join(root, CLAUDE_ROOTS, 'ws-w7'))
  const { options: inWs } = await start({ id: 'sk-5', cwd: '/work/sub' })
  expect(inWs.env?.CLAUDE_CONFIG_DIR).toBe(join(root, CLAUDE_ROOTS, 'ws-w1'))
})

it('reloads skills once at the first send after a move, never mid-turn, and not when nothing moved', async () => {
  const { reloadSkills, turn, handle, pushed, feed } = await start()
  await turn('one')
  expect(reloadSkills).not.toHaveBeenCalled()
  await handle.send('two')
  current = join(root, 'claude', 'global@bbbbbbbbbbbb')
  // A steer into the open turn: no reload.
  await handle.send('steer')
  expect(reloadSkills).not.toHaveBeenCalled()
  feed({ type: 'result', subtype: 'success', total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } } as unknown as SDKMessage)
  await tick()
  await turn('three')
  expect(reloadSkills).toHaveBeenCalledTimes(1)
  await turn('four')
  expect(reloadSkills).toHaveBeenCalledTimes(1)
  expect(pushed.length).toBe(5)
})

it('an adopted warm process whose generation is behind reloads at its first send', async () => {
  spawnGeneration = join(root, 'claude', 'global@000000000000')
  const { reloadSkills, turn } = await start({ id: 'sk-warm' })
  await turn('first')
  expect(reloadSkills).toHaveBeenCalledTimes(1)
  await turn('second')
  expect(reloadSkills).toHaveBeenCalledTimes(1)
})

it('a reload that throws lets the turn go on and is tried again at the next send', async () => {
  let fail = true
  const { reloadSkills, turn, pushed } = await start({ id: 'sk-fail' }, async () => {
    if (fail) throw new Error('no')
    return { skills: [] }
  })
  current = join(root, 'claude', 'global@bbbbbbbbbbbb')
  await turn('one')
  expect(reloadSkills).toHaveBeenCalledTimes(1)
  expect(pushed.length).toBe(1)
  fail = false
  await turn('two')
  expect(reloadSkills).toHaveBeenCalledTimes(2)
  await turn('three')
  expect(reloadSkills).toHaveBeenCalledTimes(2)
})

it('a move while the reload runs is picked up at the next send', async () => {
  const { reloadSkills, turn } = await start({ id: 'sk-race' }, async () => {
    current = join(root, 'claude', 'global@cccccccccccc')
    return { skills: [] }
  })
  current = join(root, 'claude', 'global@bbbbbbbbbbbb')
  await turn('one')
  expect(reloadSkills).toHaveBeenCalledTimes(1)
  reloadSkills.mockImplementation(async () => ({ skills: [] }))
  await turn('two')
  expect(reloadSkills).toHaveBeenCalledTimes(2)
  await turn('three')
  expect(reloadSkills).toHaveBeenCalledTimes(2)
})

it('with no store configured the spawn is today\'s', async () => {
  configureClaudeSkillRoots(null)
  endpointUrl = 'http://127.0.0.1:9/claude/~t=sk-6;a=home'
  const { options, reloadSkills, turn } = await start({ id: 'sk-6' })
  expect(options.env?.CLAUDE_CONFIG_DIR).toBe(process.env.CLAUDE_CONFIG_DIR)
  expect(options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(process.env.CLAUDE_CODE_OAUTH_TOKEN)
  current = join(root, 'claude', 'global@bbbbbbbbbbbb')
  await turn('one')
  expect(reloadSkills).not.toHaveBeenCalled()
})
