import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionMeta } from '@shared/events'
import type { DriverCtx, DriverHandle } from './types'
import type { ScopeKey } from '../skills/pointers'

/**
 * The codex driver and the skills store (plan-JBpcLz-eGMhp.md §3), over a
 * fake `codex app-server`: the argv each child is spawned with disables the
 * person's home skills by path, the store's folder is the extra root set
 * before the thread starts and again when the scope moves, and a skill added
 * to a home folder since the spawn asks for a fresh app-server.
 */

type Frame = { id?: number; method?: string; params?: Record<string, unknown> }

class FakeProc extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin: Writable
  killed = false
  methods: string[] = []
  sets: unknown[] = []
  constructor(
    public argv: string[],
    refuseSets: number
  ) {
    super()
    let refuse = refuseSets
    this.stdin = new Writable({
      write: (chunk, _enc, cb) => {
        for (const line of String(chunk).split('\n')) {
          if (!line) continue
          const frame = JSON.parse(line) as Frame
          if (frame.id === undefined) continue
          this.methods.push(frame.method!)
          if (frame.method === 'skills/extraRoots/set') {
            this.sets.push(frame.params?.extraRoots)
            if (refuse > 0) {
              refuse--
              this.out({ id: frame.id, error: { code: -32601, message: 'Method not found' } })
              continue
            }
          }
          if (frame.method === 'thread/start') {
            this.out({ id: frame.id, result: { thread: { id: 't1' } } })
            // No MCP servers: the first-turn gate opens after its grace.
            this.out({ method: 'mcpServer/startupStatus/updated', params: { name: 'x', status: 'ready' } })
          } else this.out({ id: frame.id, result: {} })
        }
        cb()
      }
    })
  }
  out(frame: Record<string, unknown>): void {
    this.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n')
  }
  kill(): void {
    this.killed = true
  }
}

const spawned: FakeProc[] = []
/** How many extraRoots sets the next spawn refuses. */
let refuseNext = 0

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: (file: string, args: string[]) => {
    const proc = new FakeProc([file, ...args], refuseNext)
    refuseNext = 0
    spawned.push(proc)
    return proc
  }
}))
vi.mock('./binaries', () => ({ resolveBinary: async () => '/fake/codex', harnessEnv: async () => ({}) }))
vi.mock('../endpoint', () => ({ routedEndpointFor: async () => ({ url: null, account: 'acct-1' }) }))
vi.mock('../apptools', () => ({ bridgeMcpConfig: () => null }))
vi.mock('../gatewayObserve', () => ({ observeCodexSnapshot: () => undefined }))

const { codexDriver, codexWarm } = await import('./codex')
const { codexLiveRoots, configureCodexSkills } = await import('../skills/codexSkills')

let tmp: string
let home: string
let gens: Record<string, string>
let moved: ((provider: 'claude' | 'codex' | 'muse', scope: ScopeKey, generation: string) => void) | null
const handles: DriverHandle[] = []
const savedHome = process.env.HOME
const savedCodexHome = process.env.CODEX_HOME

const skill = (dir: string): string => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: x\n---\n')
  return join(dir, 'SKILL.md')
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'tc-codex-drv-skills-')))
  home = join(tmp, 'home')
  process.env.HOME = home
  delete process.env.CODEX_HOME
  spawned.length = 0
  refuseNext = 0
  gens = { global: '/data/harness/codex/global@aaaaaaaaaaaa', 'ws-w1': '/data/harness/codex/global@aaaaaaaaaaaa' }
  moved = null
  configureCodexSkills({
    scopeOf: (s) => s.workspaceId,
    log: () => {},
    pointers: {
      current: (_p, ws) => ({ generation: gens[ws ? `ws-${ws}` : 'global'], movedAt: 0 }),
      onMoved: (fn) => ((moved = fn), () => {})
    }
  })
})
afterEach(async () => {
  for (const h of handles.splice(0)) await h.dispose()
  codexWarm.retire()
  for (const proc of spawned) proc.emit('exit', 0)
  configureCodexSkills(null)
  vi.unstubAllEnvs()
  process.env.HOME = savedHome
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = savedCodexHome
  rmSync(tmp, { recursive: true, force: true })
})

const session = (over: Partial<SessionMeta> = {}): SessionMeta =>
  ({ id: 'cx-1', cwd: '/repo', model: 'gpt-6-astra', permission: 'auto', reasoning: 'medium', nativeId: null, goal: null, workspaceId: null, projectId: null, ...over }) as unknown as SessionMeta

const ctx = (over: Partial<SessionMeta> = {}): DriverCtx => ({ session: session(over), emit: () => {}, setNativeId: () => {}, requestApproval: async () => true })

async function start(over: Partial<SessionMeta> = {}): Promise<DriverHandle> {
  const h = await codexDriver.start(ctx(over))
  handles.push(h)
  return h
}

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
/** What the child got after the binary (the nice and ionice prefix comes before it). */
const codexArgs = (proc: FakeProc): string[] => proc.argv.slice(proc.argv.indexOf('/fake/codex') + 1)
const skillsArg = (proc: FakeProc): string | undefined => codexArgs(proc)[codexArgs(proc).indexOf('-c') + 1]

it('the cold child\'s argv disables both home roots\' skills by path, both spellings of a linked one, never .system', async () => {
  vi.stubEnv('TEMP_CODE_WARM_HARNESS', '0')
  const a = skill(join(home, '.codex/skills/alpha'))
  const b = skill(join(home, '.agents/skills/beta'))
  skill(join(home, '.codex/skills/.system/builtin'))
  const real = skill(join(tmp, 'elsewhere/gamma'))
  symlinkSync(join(tmp, 'elsewhere/gamma'), join(home, '.agents/skills/gamma'))
  await start()
  const proc = spawned[0]
  expect(codexArgs(proc)).toEqual(['-c', skillsArg(proc), 'app-server'])
  const arg = skillsArg(proc)!
  for (const f of [a, b, real, join(home, '.agents/skills/gamma/SKILL.md')]) expect(arg).toContain(`{path="${f}",enabled=false}`)
  expect(arg).not.toContain('.system')
  // The root is set after initialize and before the thread starts.
  expect(proc.methods.slice(0, 3)).toEqual(['initialize', 'skills/extraRoots/set', 'thread/start'])
  expect(proc.sets).toEqual([[`${gens.global}/skills`]])
})

it('with no home skills the argv is the plain app-server, and the root is still set', async () => {
  vi.stubEnv('TEMP_CODE_WARM_HARNESS', '0')
  await start()
  expect(codexArgs(spawned[0])).toEqual(['app-server'])
  expect(spawned[0].sets).toEqual([[`${gens.global}/skills`]])
})

it('a warm app-server is spawned with the same argv, and its adopter sets the root before its thread starts', async () => {
  skill(join(home, '.codex/skills/alpha'))
  await start({ id: 'cx-cold' })
  await codexWarm.settled()
  expect(spawned).toHaveLength(2)
  const warm = spawned[1]
  expect(warm.argv).toEqual(spawned[0].argv)
  expect(warm.methods).toEqual(['initialize'])
  gens.global = '/data/harness/codex/global@bbbbbbbbbbbb'
  await start({ id: 'cx-warm' })
  expect(warm.methods.slice(0, 3)).toEqual(['initialize', 'skills/extraRoots/set', 'thread/start'])
  expect(warm.sets).toEqual([[`${gens.global}/skills`]])
})

it('a move re-sets the root on every live handle of that scope only; codexLiveRoots lists what each holds', async () => {
  vi.stubEnv('TEMP_CODE_WARM_HARNESS', '0')
  gens['ws-w1'] = '/data/harness/codex/ws-w1@cccccccccccc'
  await start({ id: 'cx-g' })
  await start({ id: 'cx-w', workspaceId: 'w1' })
  const [g, w] = spawned
  expect([...codexLiveRoots()].sort()).toEqual(['/data/harness/codex/global@aaaaaaaaaaaa', '/data/harness/codex/ws-w1@cccccccccccc'])
  gens.global = '/data/harness/codex/global@dddddddddddd'
  moved!('codex', 'global', gens.global)
  await tick(10)
  expect(g.sets.at(-1)).toEqual([`${gens.global}/skills`])
  expect(w.sets).toEqual([['/data/harness/codex/ws-w1@cccccccccccc/skills']])
  moved!('claude', 'global', gens.global)
  await tick(10)
  expect(g.sets).toHaveLength(2)
  expect([...codexLiveRoots()].sort()).toEqual(['/data/harness/codex/global@dddddddddddd', '/data/harness/codex/ws-w1@cccccccccccc'])
})

it('a refused set logs and the thread still starts; a failed re-set is sent again before the next turn/start', async () => {
  vi.stubEnv('TEMP_CODE_WARM_HARNESS', '0')
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  refuseNext = 2
  const h = await start({ id: 'cx-refuse' })
  const proc = spawned[0]
  expect(proc.methods).toContain('thread/start')
  expect(warn.mock.calls.some(([l]) => String(l).includes('skills/extraRoots/set refused'))).toBe(true)
  expect(codexLiveRoots().size).toBe(0)
  // The move's re-set is refused too; the turn sends it again first.
  gens.global = '/data/harness/codex/global@eeeeeeeeeeee'
  moved!('codex', 'global', gens.global)
  await tick(10)
  expect(proc.sets).toHaveLength(2)
  await tick(600)
  await h.send('hello')
  await tick(10)
  const turn = proc.methods.lastIndexOf('turn/start')
  expect(proc.methods[turn - 1]).toBe('skills/extraRoots/set')
  expect(proc.sets.at(-1)).toEqual([`${gens.global}/skills`])
  expect([...codexLiveRoots()]).toEqual([gens.global])
  warn.mockRestore()
})

it('a SKILL.md added to a home root asks for a fresh app-server at the next turn start, whose argv carries it', async () => {
  vi.stubEnv('TEMP_CODE_WARM_HARNESS', '0')
  skill(join(home, '.codex/skills/alpha'))
  mkdirSync(join(home, '.codex/skills/build'), { recursive: true })
  const h = await start({ id: 'cx-home' })
  expect(h.needsReboot?.()).toBeNull()
  const added = skill(join(home, '.codex/skills/build'))
  expect(h.needsReboot?.()).toBe('home skills changed')
  await start({ id: 'cx-home-2' })
  expect(skillsArg(spawned[1])).toContain(`{path="${added}",enabled=false}`)
})

it('with no store configured the spawn is today\'s: no disables, no extra root, never a reboot', async () => {
  vi.stubEnv('TEMP_CODE_WARM_HARNESS', '0')
  configureCodexSkills(null)
  skill(join(home, '.codex/skills/alpha'))
  const h = await start({ id: 'cx-none' })
  expect(codexArgs(spawned[0])).toEqual(['app-server'])
  expect(spawned[0].methods).not.toContain('skills/extraRoots/set')
  skill(join(home, '.codex/skills/later'))
  expect(h.needsReboot?.()).toBeNull()
})
