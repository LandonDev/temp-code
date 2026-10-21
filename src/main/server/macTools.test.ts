import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { ServerFrame } from '@shared/contract'
import {
  MAC_TOOL_DESCRIPTIONS,
  MAC_TOOL_PARAMS,
  type MacBridgePush
} from '@shared/contract-macbridge'
import type { SessionMeta } from '@shared/events'
import {
  MacThreadTokens,
  MacTools,
  landingName,
  rebootWhenSettled,
  withMacTools,
  macToolsHooks,
  MAC_TOOLS
} from './macTools'
import { macBridgeLandingDir } from './macBridgeLanding'
import {
  PeerCalls,
  servePeerCall,
  handlePeerRequest,
  type PeerCallHandler
} from './remote/peerCalls'

const dir = mkdtempSync(join(tmpdir(), 'tc-mactools-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    id,
    parentId: null,
    projectId: null,
    workspaceId: null,
    title: `T ${id}`,
    status: 'idle',
    permission: 'safe',
    ...extra
  }) as SessionMeta

function setup(handler: PeerCallHandler = async () => 'ok', opts: { register?: boolean } = {}) {
  const settings = new Map<string, string>()
  const sessions = new Map<string, SessionMeta>([
    ['root', meta('root', { projectId: 'p1' })],
    ['child', meta('child', { parentId: 'root', projectId: 'p1' })],
    ['loose', meta('loose')],
    ['ws', meta('ws', { workspaceId: 'w1' })]
  ])
  const calls = new PeerCalls('env_box', () => {})
  const tokens = new MacThreadTokens('ab'.repeat(16))
  const reboots: string[] = []
  const pushes: MacBridgePush[] = []
  const socket = {
    connection: 1,
    keyId: 'k',
    remote: true,
    send: (frame: ServerFrame) => {
      if (!('push' in frame) || frame.push !== 'peer.call') return
      pushes.push(frame as MacBridgePush)
      void servePeerCall(
        frame as Extract<MacBridgePush, { push: 'peer.call' }>,
        'env_box',
        handler,
        async (m, p) =>
          handlePeerRequest(calls, socket, { method: m, params: p } as Parameters<
            typeof handlePeerRequest
          >[2])
      )
    }
  }
  if (opts.register !== false)
    handlePeerRequest(calls, socket, {
      method: 'peer.register',
      params: { from: 'env_mac', offers: ['mac-bridge'] }
    })
  const tools = new MacTools({
    store: {
      getSetting: (k) => settings.get(k) ?? null,
      setSetting: (k, v) => (v === null ? settings.delete(k) : settings.set(k, v))
    },
    sessions: { get: (id) => sessions.get(id) ?? null },
    landing: {
      getProject: (id) => (id === 'p1' ? { cwd: join(dir, 'proj') } : null),
      getWorkspace: (id) => (id === 'w1' ? { path: join(dir, 'ws') } : null)
    },
    dataDir: join(dir, 'data'),
    calls,
    tokens,
    reboot: (id) => reboots.push(id),
    log: () => {}
  })
  return { tools, tokens, settings, reboots, pushes, calls }
}

describe('MacThreadTokens', () => {
  it('one token per thread; a seed fixes the key, otherwise it is random per process', () => {
    const a = new MacThreadTokens('ab'.repeat(16))
    const b = new MacThreadTokens('ab'.repeat(16))
    expect(a.tokenFor('s1')).toBe(b.tokenFor('s1'))
    expect(a.tokenFor('s1')).not.toBe(a.tokenFor('s2'))
    expect(new MacThreadTokens().tokenFor('s1')).not.toBe(new MacThreadTokens().tokenFor('s1'))
    expect(a.check('s1', a.tokenFor('s1'))).toBe(true)
    expect(a.check('s2', a.tokenFor('s1'))).toBe(false)
    expect(a.check('s1', 'x')).toBe(false)
    expect(a.check('s1', undefined)).toBe(false)
  })
  it('the seed is honoured only for an isolated instance', () => {
    const seed = 'cd'.repeat(16)
    const fixed = new MacThreadTokens(seed).tokenFor('s')
    expect(MacThreadTokens.fromEnv({ TEMP_CODE_MAC_TOKEN_SEED: seed }).tokenFor('s')).not.toBe(
      fixed
    )
    expect(
      MacThreadTokens.fromEnv({
        TEMP_CODE_MAC_TOKEN_SEED: seed,
        TEMP_CODE_USER_DATA: '/tmp/x'
      }).tokenFor('s')
    ).toBe(fixed)
  })
})

describe('MacTools gate', () => {
  it('a wrong or missing token is refused before anything else', async () => {
    const { tools, tokens } = setup()
    tools.setThread('root', 'env_mac')
    await expect(tools.call('root', 'nope', 'mac.listDir', { path: '/x' })).rejects.toThrow(
      /needs this thread's own token/
    )
    await expect(
      tools.call('root', tokens.tokenFor('loose'), 'mac.listDir', { path: '/x' })
    ).rejects.toThrow(/own token/)
    await expect(tools.call('root', undefined, 'mac.listDir', { path: '/x' })).rejects.toThrow(
      /own token/
    )
  })

  it('off unless the thread or an ancestor names a Mac', async () => {
    const { tools, tokens } = setup()
    await expect(
      tools.call('root', tokens.tokenFor('root'), 'mac.listDir', { path: '/x' })
    ).rejects.toThrow(/off for this thread/)
    expect(tools.bridgeEnv('root')).toEqual({})
    tools.setThread('root', 'env_mac')
    expect(tools.macPeerOf('child')).toEqual({ macPeer: 'env_mac', inherited: true })
    expect(tools.bridgeEnv('child')).toEqual({ TEMP_CODE_MAC_TOKEN: tokens.tokenFor('child') })
    expect(tools.enabled('loose')).toBe(false)
    await expect(
      tools.call('child', tokens.tokenFor('child'), 'mac.listDir', { path: '/x' })
    ).resolves.toBe('ok')
  })

  it('a toggle reboots the thread only when it changes', () => {
    const { tools, reboots } = setup()
    tools.setThread('root', 'env_mac')
    tools.setThread('root', 'env_mac')
    expect(tools.threadState('root')).toMatchObject({
      macPeer: 'env_mac',
      inherited: false,
      online: true,
      registered: ['env_mac']
    })
    tools.setThread('root', null)
    expect(reboots).toEqual(['root', 'root'])
    expect(() => tools.setThread('ghost', 'env_mac')).toThrow(/unknown session/)
  })

  it('answers Mac offline when no Mac registered', async () => {
    const { tools, tokens } = setup(async () => 'x', { register: false })
    tools.setThread('root', 'env_mac')
    expect(tools.threadState('root').online).toBe(false)
    await expect(
      tools.call('root', tokens.tokenFor('root'), 'mac.readFile', { path: '/x' })
    ).rejects.toThrow(/Mac offline/)
  })

  it('forwards the thread, the args and a deadline that covers the approval and the timeout', async () => {
    const { tools, tokens, pushes } = setup(async (method, params) => ({ method, params }))
    tools.setThread('root', 'env_mac')
    const out = (await tools.call('root', tokens.tokenFor('root'), 'mac.run', {
      argv: ['ls'],
      timeoutMs: 5_000
    })) as { params: unknown }
    expect(out.params).toEqual({
      thread: { id: 'root', title: 'T root' },
      args: { argv: ['ls'], timeoutMs: 5_000 }
    })
    const push = pushes[0] as Extract<MacBridgePush, { push: 'peer.call' }>
    expect(push.deadlineMs).toBe(10 * 60_000 + 5_000 + 30_000)
    await expect(
      tools.call('root', tokens.tokenFor('root'), 'mac.run', { argv: ['ls'], command: 'ls' })
    ).rejects.toThrow(/one of them/)
  })

  it("fetchFile lands the file in the thread's landing dir, never overwriting", async () => {
    const body = Buffer.from('fetched bytes')
    const { tools, tokens } = setup(async () => ({
      name: '../../etc/evil.txt',
      size: body.length,
      mtime: 1,
      dataBase64: body.toString('base64')
    }))
    tools.setThread('root', 'env_mac')
    const first = (await tools.call('root', tokens.tokenFor('root'), 'mac.fetchFile', {
      path: '/Users/me/evil.txt'
    })) as { path: string; size: number }
    expect(first.path).toBe(join(dir, 'proj', '.temp-code', 'attachments', 'root', 'evil.txt'))
    expect(readFileSync(first.path, 'utf8')).toBe('fetched bytes')
    const second = (await tools.call('root', tokens.tokenFor('root'), 'mac.fetchFile', {
      path: '/Users/me/evil.txt'
    })) as { path: string }
    expect(second.path).toBe(join(dir, 'proj', '.temp-code', 'attachments', 'root', 'evil (1).txt'))
  })

  it('a damaged file is refused and nothing lands', async () => {
    const { tools, tokens } = setup(async () => ({
      name: 'x.bin',
      size: 99,
      mtime: 1,
      dataBase64: Buffer.from('short').toString('base64')
    }))
    tools.setThread('loose', 'env_mac')
    await expect(
      tools.call('loose', tokens.tokenFor('loose'), 'mac.fetchFile', { path: '/x.bin' })
    ).rejects.toThrow(/damaged/)
    expect(existsSync(join(dir, 'data', 'attachments', 'loose', 'x.bin'))).toBe(false)
  })
})

describe('macBridgeLandingDir', () => {
  it('project cwd, else workspace path, else userData', () => {
    const lookup = {
      getProject: (id: string) => (id === 'p1' ? { cwd: '/repo' } : null),
      getWorkspace: (id: string) => (id === 'w1' ? { path: '/ws' } : null)
    }
    expect(
      macBridgeLandingDir({ id: 's', projectId: 'p1', workspaceId: 'w1' }, lookup, '/data')
    ).toBe('/repo/.temp-code/attachments/s')
    expect(
      macBridgeLandingDir({ id: 's', projectId: null, workspaceId: 'w1' }, lookup, '/data')
    ).toBe('/ws/.temp-code/attachments/s')
    expect(
      macBridgeLandingDir({ id: 's', projectId: null, workspaceId: null }, lookup, '/data')
    ).toBe('/data/attachments/s')
  })
  it('landing names are base names only', () => {
    expect(landingName('../../x')).toBe('x')
    expect(landingName('.hidden')).toBe('_hidden')
    expect(landingName('a\nb')).toBe('a_b')
    expect(landingName('')).toBe('file')
  })
})

describe('withMacTools', () => {
  it('adds the mac server and allows its tools only while the bridge is on', () => {
    const { tools } = setup()
    macToolsHooks.current = tools
    const opts = () => ({ mcpServers: { app: {} as never }, allowedTools: ['mcp__app__x'] })
    expect(Object.keys(withMacTools(opts(), meta('root')).mcpServers ?? {})).toEqual(['app'])
    tools.setThread('root', 'env_mac')
    const on = withMacTools(opts(), meta('root'))
    expect(Object.keys(on.mcpServers ?? {})).toEqual(['app', 'mac'])
    expect(on.allowedTools).toEqual(['mcp__app__x', ...MAC_TOOLS])
    macToolsHooks.current = null
  })
})

describe('rebootWhenSettled', () => {
  it('drops an idle thread now and a running one once it settles', () => {
    const listeners = new Set<(m: SessionMeta) => void>()
    const state = new Map<string, SessionMeta>([
      ['a', meta('a')],
      ['b', meta('b', { status: 'running' })]
    ])
    const setPermission = vi.fn(async () => {})
    const reg = {
      get: (id: string) => state.get(id) ?? null,
      onMeta: (l: (m: SessionMeta) => void) => (listeners.add(l), () => listeners.delete(l)),
      setPermission
    }
    const live = (s: SessionMeta['status']): boolean => s === 'running'
    rebootWhenSettled(reg, 'a', live)
    expect(setPermission).toHaveBeenCalledWith('a', 'safe')
    rebootWhenSettled(reg, 'b', live)
    expect(setPermission).toHaveBeenCalledTimes(1)
    for (const l of [...listeners]) l(meta('b', { status: 'running' }))
    expect(setPermission).toHaveBeenCalledTimes(1)
    state.set('b', meta('b', { status: 'idle' }))
    for (const l of [...listeners]) l(meta('b', { status: 'idle' }))
    expect(setPermission).toHaveBeenCalledTimes(2)
    expect(listeners.size).toBe(0)
  })
})

describe('the codex bridge keeps the Mac tools equal', async () => {
  const bridge = (await import(
    join(import.meta.dirname, '..', '..', '..', 'scripts', 'app-mcp-bridge.mjs')
  )) as {
    MAC_TOOLS: {
      name: string
      description: string
      inputSchema: { properties: Record<string, { description?: string }> }
    }[]
    TOOLS: { name: string }[]
    listedTools: (token?: string) => { name: string }[]
  }
  it('same descriptions and params as the shared constants', () => {
    expect(bridge.MAC_TOOLS.map((t) => t.name)).toEqual(Object.keys(MAC_TOOL_DESCRIPTIONS))
    for (const t of bridge.MAC_TOOLS) {
      expect(t.description).toBe(
        MAC_TOOL_DESCRIPTIONS[t.name as keyof typeof MAC_TOOL_DESCRIPTIONS]
      )
      for (const [k, v] of Object.entries(t.inputSchema.properties))
        expect(v.description).toBe(MAC_TOOL_PARAMS[k as keyof typeof MAC_TOOL_PARAMS])
    }
  })
  it('lists them only with a token', () => {
    expect(bridge.listedTools(undefined).some((t) => t.name.startsWith('mac_'))).toBe(false)
    expect(bridge.listedTools('tok').filter((t) => t.name.startsWith('mac_')).length).toBe(4)
  })
})
