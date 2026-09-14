import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type FakeChild = EventEmitter & {
  stdout: EventEmitter
  kill: () => boolean
  exitCode: number | null
  signalCode: string | null
}
const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  children: [] as FakeChild[],
  args: [] as string[][],
  provider: 'claude' as string
}))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('./drivers/binaries', () => ({
  resolveBinary: vi.fn(async (name: string) => `/test/${name}`),
  harnessEnv: vi.fn(async () => ({}))
}))
import { CLAUDE_BARE_ARGS, codexMcpOverrides, setSummarizeContext, summarizeTools } from './summarize'
import type { SessionRegistry } from './sessions'
import type { Store } from './db'

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new EventEmitter()
  child.kill = () => true
  child.exitCode = null
  child.signalCode = null
  return child
}
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
function finish(child: FakeChild, text: string): void {
  child.stdout.emit('data', text)
  child.exitCode = 0
  child.emit('exit', 0)
}

beforeEach(() => {
  mocks.children.length = 0
  mocks.args.length = 0
  mocks.provider = 'claude'
  mocks.spawn.mockReset()
  mocks.spawn.mockImplementation((_bin: string, args: string[]) => {
    const child = fakeChild()
    mocks.children.push(child)
    mocks.args.push(args)
    return child
  })
  setSummarizeContext(
    { get: () => ({ provider: mocks.provider }) } as unknown as SessionRegistry,
    {
      getSetting: () => null,
      setSetting: () => undefined,
      listSessions: () => []
    } as unknown as Store
  )
})

const item = { name: 'Read', detail: 'src/a.ts' }

describe('summarizeTools', () => {
  it('runs claude with MCP servers, tools and skills off', async () => {
    const p = summarizeTools('s1', 'g1', [item], 'haiku', false)
    await settle()
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    expect(mocks.spawn.mock.calls[0][0]).toBe('/test/claude')
    const args = mocks.args[0]
    expect(args.slice(0, 1)).toEqual(['-p'])
    expect(args).toContain('--strict-mcp-config')
    expect(args.slice(args.indexOf('--mcp-config'), args.indexOf('--mcp-config') + 2)).toEqual([
      '--mcp-config',
      '{"mcpServers":{}}'
    ])
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual(['--tools', ''])
    expect(args).toContain('--disable-slash-commands')
    expect(args.slice(-CLAUDE_BARE_ARGS.length)).toEqual(CLAUDE_BARE_ARGS)
    finish(mocks.children[0], 'I read a file.')
    expect(await p).toEqual({ sentence: 'I read a file.', captions: [null] })
  })

  it('runs at most two one-shots at a time; the rest wait their turn', async () => {
    const all = ['a', 'b', 'c', 'd', 'e'].map((k) =>
      summarizeTools('s1', `g-${k}`, [item], 'haiku', false)
    )
    await settle()
    expect(mocks.spawn).toHaveBeenCalledTimes(2)
    finish(mocks.children[0], 'one')
    await settle()
    expect(mocks.spawn).toHaveBeenCalledTimes(3)
    finish(mocks.children[1], 'two')
    finish(mocks.children[2], 'three')
    await settle()
    expect(mocks.spawn).toHaveBeenCalledTimes(5)
    finish(mocks.children[3], 'four')
    finish(mocks.children[4], 'five')
    const results = await Promise.all(all)
    expect(results.map((r) => r?.sentence)).toEqual(['one', 'two', 'three', 'four', 'five'])
  })

  it('runs codex threads through codex exec without session files', async () => {
    mocks.provider = 'codex'
    const p = summarizeTools('s2', 'g2', [item], 'auto', false)
    await settle()
    expect(mocks.spawn.mock.calls[0][0]).toBe('/test/codex')
    const args = mocks.args[0]
    expect(args.slice(0, 3)).toEqual(['exec', '-s', 'read-only'])
    expect(args).toContain('--ephemeral')
    expect(args).toContain('-m')
    finish(mocks.children[0], '')
    await p
  })
})

describe('codexMcpOverrides', () => {
  it('turns off every server named in config.toml and skips sub-tables', () => {
    const toml = [
      'model = "gpt-5.5"',
      '[mcp_servers.heroui]',
      'command = "npx"',
      '[mcp_servers.convex]',
      'command = "npx"',
      '[mcp_servers.convex.tools.status]',
      'enabled = true',
      '  [mcp_servers.node_repl]  ',
      '[mcp_servers.node_repl.env]',
      'X = "1"',
      '[profiles.fast]',
      'model = "x"'
    ].join('\n')
    expect(codexMcpOverrides(toml)).toEqual([
      '-c',
      'mcp_servers.heroui.enabled=false',
      '-c',
      'mcp_servers.convex.enabled=false',
      '-c',
      'mcp_servers.node_repl.enabled=false'
    ])
    expect(codexMcpOverrides('')).toEqual([])
  })
})
