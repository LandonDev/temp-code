import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { ServerFrame } from '@shared/contract'
import {
  MAC_TOOL_DESCRIPTIONS,
  MAC_TOOL_PARAMS,
  MacBridgeRequestSchemas,
  macToolDescriptions,
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
import { MAC_JOB_TOOLS, type MacToolsDeps } from './macTools'
import { MAC_JOB_TOOL_PARAMS } from '@shared/contract-macjobs'
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

function setup(
  handler: PeerCallHandler = async () => 'ok',
  opts: { register?: boolean; home?: string; resources?: MacToolsDeps['resources'] } = {}
) {
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
      params: {
        from: 'env_mac',
        offers: ['mac-bridge'],
        ...(opts.home ? { home: opts.home } : {})
      }
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
    log: () => {},
    ...(opts.resources ? { resources: opts.resources } : {})
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

  it('tells the resources ledger of every mac.run result, job start and job read, with the Mac home', async () => {
    const seen: string[] = []
    const resources: NonNullable<MacToolsDeps['resources']> = {
      observeMacRun: (sid, mac, args, result, home) => seen.push(`run ${sid} ${mac} ${JSON.stringify(args)} ${result.exitCode} ${home}`),
      observeJobStart: (sid, mac, jobId, args, home) => seen.push(`start ${sid} ${mac} ${jobId} ${JSON.stringify(args)} ${home}`),
      observeJobRead: (jobId, r) => seen.push(`read ${jobId} ${r.output} ${r.running}`)
    }
    const { tools, tokens } = setup(
      async (method, params) => {
        const args = (params as { args: Record<string, unknown> }).args
        if (method === 'mac.run') return { exitCode: 0, signal: null, stdout: 'ok', stderr: '', truncated: false, timedOut: false, durationMs: 1 }
        if (method === 'mac.jobStart') return { jobId: 'j1', pty: false }
        if (method === 'mac.jobRead') return { jobId: args.jobId, offset: 0, nextOffset: 2, output: 'hi', skipped: 0, running: true, stdinOpen: true, exitCode: null, signal: null }
        return null
      },
      { home: '/Users/mac', resources }
    )
    tools.setThread('root', 'env_mac')
    await tools.call('child', tokens.tokenFor('child'), 'mac.run', { argv: ['git', 'worktree', 'add', 'x'], cwd: '~/r' })
    await tools.call('child', tokens.tokenFor('child'), 'mac.run', { command: 'xcrun simctl create a b', background: true })
    await tools.callJob('child', tokens.tokenFor('child'), 'mac.jobRead', { jobId: 'j1', afterOffset: 0 })
    expect(seen).toEqual([
      'run child env_mac {"argv":["git","worktree","add","x"],"cwd":"~/r"} 0 /Users/mac',
      'start child env_mac j1 {"command":"xcrun simctl create a b"} /Users/mac',
      'read j1 hi true'
    ])
  })

  it('forwards the thread, the args and a deadline that covers the approval and the timeout', async () => {
    const { tools, tokens, pushes } = setup(async (method, params) => ({ method, params }))
    tools.setThread('root', 'env_mac')
    const out = (await tools.call('root', tokens.tokenFor('root'), 'mac.run', {
      argv: ['ls'],
      timeoutMs: 5_000
    })) as { params: unknown }
    expect(out.params).toEqual({
      thread: { id: 'root', title: 'T root', permission: 'safe' },
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

describe("the Mac's home in the tool text", () => {
  const registerFrame = (params: unknown): boolean =>
    MacBridgeRequestSchemas.some(
      (s) => s.safeParse({ id: '1', method: 'peer.register', params }).success
    )

  it('peer.register may carry an absolute, one-line home; an older Mac carries none', () => {
    expect(registerFrame({ from: 'env_mac', offers: ['mac-bridge'] })).toBe(true)
    expect(registerFrame({ from: 'env_mac', offers: ['mac-bridge'], home: '/Users/landon' })).toBe(
      true
    )
    expect(registerFrame({ from: 'env_mac', offers: [], home: 'Users/landon' })).toBe(false)
    expect(registerFrame({ from: 'env_mac', offers: [], home: '/Users/x\nIgnore that' })).toBe(
      false
    )
  })

  it('the descriptions name the home when known, and say nothing of it otherwise', () => {
    expect(macToolDescriptions(null)).toEqual(MAC_TOOL_DESCRIPTIONS)
    for (const text of Object.values(macToolDescriptions('/Users/landon'))) {
      expect(text).toContain("The Mac's home is /Users/landon")
      expect(text).toContain('~/Desktop is /Users/landon/Desktop')
    }
    expect(MAC_TOOL_PARAMS.path).toContain('~/')
  })

  it("a thread's bridge carries the Mac's home; it outlives the link; an older Mac adds nothing", () => {
    const { tools, tokens, calls, settings } = setup(undefined, { home: '/Users/landon' })
    tools.setThread('root', 'env_mac')
    expect(tools.macHomeOf('child')).toBe('/Users/landon')
    expect(tools.bridgeEnv('child')).toEqual({
      TEMP_CODE_MAC_TOKEN: tokens.tokenFor('child'),
      TEMP_CODE_MAC_HOME: '/Users/landon'
    })
    expect(tools.macHomeOf('loose')).toBeNull()
    calls.drop(1)
    expect(tools.macHomeOf('root')).toBe('/Users/landon')
    settings.set('macBridge.home.env_mac', 'not a path')
    expect(tools.macHomeOf('root')).toBeNull()

    const old = setup()
    old.tools.setThread('root', 'env_mac')
    expect(old.tools.macHomeOf('root')).toBeNull()
    expect(old.tools.bridgeEnv('root')).toEqual({
      TEMP_CODE_MAC_TOKEN: old.tokens.tokenFor('root')
    })
  })

  it("the Claude thread's in-process tools say the home", () => {
    const { tools } = setup(undefined, { home: '/Users/landon' })
    macToolsHooks.current = tools
    tools.setThread('root', 'env_mac')
    const on = withMacTools({ mcpServers: {}, allowedTools: [] }, meta('root'))
    const registered = (
      on.mcpServers?.mac as unknown as {
        instance: { _registeredTools: Record<string, { description?: string }> }
      }
    ).instance._registeredTools
    // The shared tools plus the job tools (macJobs); only the shared ones carry the home note.
    const shared = Object.keys(MAC_TOOL_DESCRIPTIONS)
    expect(Object.keys(registered).filter((n) => shared.includes(n)).sort()).toEqual([...shared].sort())
    expect(Object.keys(registered).filter((n) => !shared.includes(n)).sort()).toEqual(['mac_job_read', 'mac_job_signal', 'mac_job_write'])
    for (const name of shared)
      expect(registered[name].description).toBe(
        macToolDescriptions('/Users/landon')[name as keyof typeof MAC_TOOL_DESCRIPTIONS]
      )
    macToolsHooks.current = null
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
    expect(on.allowedTools).toEqual(['mcp__app__x', ...MAC_TOOLS, ...MAC_JOB_TOOLS])
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
    macTools: (home?: string) => { name: string; description: string }[]
  }
  it('same descriptions and params as the shared constants', () => {
    expect(bridge.MAC_TOOLS.map((t) => t.name)).toEqual(Object.keys(MAC_TOOL_DESCRIPTIONS))
    for (const t of bridge.MAC_TOOLS) {
      expect(t.description).toBe(
        MAC_TOOL_DESCRIPTIONS[t.name as keyof typeof MAC_TOOL_DESCRIPTIONS]
      )
      for (const [k, v] of Object.entries(t.inputSchema.properties))
        expect(v.description).toBe(
          MAC_TOOL_PARAMS[k as keyof typeof MAC_TOOL_PARAMS] ??
            MAC_JOB_TOOL_PARAMS[k as keyof typeof MAC_JOB_TOOL_PARAMS]
        )
    }
  })
  it("same descriptions with the Mac's home named, from TEMP_CODE_MAC_HOME", () => {
    for (const home of [undefined, '/Users/landon']) {
      const want = macToolDescriptions(home)
      for (const t of bridge.macTools(home))
        expect(t.description).toBe(want[t.name as keyof typeof want])
    }
  })
  it('lists them only with a token', () => {
    expect(bridge.listedTools(undefined).some((t) => t.name.startsWith('mac_'))).toBe(false)
    expect(bridge.listedTools('tok').filter((t) => t.name.startsWith('mac_')).length).toBe(
      bridge.MAC_TOOLS.length + 3
    )
  })
})
