import { describe, expect, it, vi } from 'vitest'
import type { PublishStartArgs } from '@shared/contract-publish'
import type { Publisher } from '../hostJobs'
import { HostLog } from '../hostJobs'
import { MacPublish, macPublishOffers } from './macPublish'

const BOX = 'box'
const SHA = 'a'.repeat(40)
const args: PublishStartArgs = {
  sha: SHA,
  branch: 'master',
  version: '1.0.277',
  notes: 'Ship the fixes'
}
const params = { caller: { environmentId: BOX, sessionId: 'thread' }, args }
const context = () => ({
  from: BOX,
  callId: 'call',
  deadlineAt: Date.now() + 60_000,
  progress: vi.fn()
})

function setup(
  state: { sha?: string; version?: string; gitError?: string; refusal?: string } = {}
) {
  const log = new HostLog('publish', true)
  const publisher = {
    log,
    checkout: () => '/mac/checkout',
    git: vi.fn(async (argv: string[], cwd: string) => {
      expect(cwd).toBe('/mac/checkout')
      if (state.gitError) throw new Error(state.gitError)
      if (argv[0] === 'rev-parse') return `${state.sha ?? SHA}\n`
      if (argv[0] === 'show') return JSON.stringify({ version: state.version ?? args.version })
      return ''
    }),
    publish: vi.fn(async () => {
      if (state.refusal) throw new Error(state.refusal)
      log.reset({ ...log.status, phase: 'running' })
    }),
    stop: vi.fn(() => log.setStatus({ ...log.status, phase: 'done', exit: 143 }))
  }
  const replies: { method: string; params: unknown }[] = []
  const request = vi.fn(async (method: string, body?: unknown) => {
    replies.push({ method, params: body })
  })
  const mac = new MacPublish({
    environmentId: 'mac',
    environments: () => [{ id: BOX, name: 'Box' }],
    link: () => request,
    publisher: publisher as unknown as Publisher
  })
  const finish = (exit: number) => log.setStatus({ ...log.status, phase: 'done', exit })
  return { mac, publisher, log, finish, replies, request }
}

describe('MacPublish', () => {
  it('pulls the named branch with the Publisher git, checks HEAD and version, then publishes without cutting a release', async () => {
    const { mac, publisher, finish } = setup()
    const run = mac.handle('publish.start', params, context())
    await vi.waitFor(() =>
      expect(publisher.publish).toHaveBeenCalledWith(args.notes, { train: false })
    )
    expect(publisher.git.mock.calls).toEqual([
      [['fetch', 'origin'], '/mac/checkout'],
      [['pull', '--ff-only', 'origin', 'master'], '/mac/checkout'],
      [['rev-parse', 'HEAD'], '/mac/checkout'],
      [['show', 'HEAD:package.json'], '/mac/checkout']
    ])
    finish(0)
    await expect(run).resolves.toEqual({
      ok: true,
      exit: 0,
      version: args.version,
      text: 'Published 1.0.277'
    })
  })

  it('streams every append, returns the last meaningful failure line, and unsubscribes when done', async () => {
    const { mac, publisher, log, finish } = setup()
    const ctx = context()
    const run = mac.handle('publish.start', params, ctx)
    await vi.waitFor(() => expect(publisher.publish).toHaveBeenCalled())
    log.append('building\nnotarization failed\n')
    log.append('\n== exited 1\n')
    expect(ctx.progress.mock.calls).toEqual([
      ['building\nnotarization failed\n'],
      ['\n== exited 1\n']
    ])
    finish(1)
    await expect(run).resolves.toEqual({
      ok: false,
      exit: 1,
      version: args.version,
      text: 'notarization failed'
    })
    expect(log.subscriberCount).toBe(0)
  })

  it('refuses a different SHA after pulling and never publishes', async () => {
    const { mac, publisher } = setup({ sha: 'b'.repeat(40) })
    await expect(mac.handle('publish.start', params, context())).rejects.toThrow(
      "the Mac's checkout is at bbbbbbb after the pull, not aaaaaaa"
    )
    expect(publisher.publish).not.toHaveBeenCalled()
    expect(publisher.git.mock.calls.map(([argv]) => argv[0])).toEqual([
      'fetch',
      'pull',
      'rev-parse'
    ])
  })

  it('refuses a different HEAD package version before spawning', async () => {
    const { mac, publisher } = setup({ version: '1.0.278' })
    await expect(mac.handle('publish.start', params, context())).rejects.toThrow(
      "the Mac's checkout is at 1.0.278, not 1.0.277"
    )
    expect(publisher.publish).not.toHaveBeenCalled()
  })

  it('passes git errors back unchanged and releases its start slot', async () => {
    const state = { gitError: 'fatal: Not possible to fast-forward, aborting.' }
    const { mac, publisher, finish } = setup(state)
    await expect(mac.handle('publish.start', params, context())).rejects.toThrow(state.gitError)
    state.gitError = ''
    const run = mac.handle('publish.start', params, context())
    await vi.waitFor(() => expect(publisher.publish).toHaveBeenCalled())
    finish(0)
    await run
  })

  it.each([
    'the tree has uncommitted changes; commit first',
    'the checkout is on feature, not master',
    'v1.0.277 is already published; the feed serves it',
    'a publish is already running'
  ])('returns the Publisher refusal: %s', async (refusal) => {
    const { mac, log } = setup({ refusal })
    await expect(mac.handle('publish.start', params, context())).rejects.toThrow(refusal)
    expect(log.subscriberCount).toBe(0)
  })

  it('checks the host and caller on both methods before doing work', async () => {
    const { mac, publisher } = setup()
    for (const method of ['publish.start', 'publish.stop'] as const) {
      const body = { ...params, ...(method === 'publish.stop' ? { args: {} } : {}) }
      await expect(mac.handle(method, body, { ...context(), from: 'stranger' })).rejects.toThrow(
        'this Mac does not know that host'
      )
      await expect(
        mac.handle(
          method,
          { ...body, caller: { ...params.caller, environmentId: 'other' } },
          context()
        )
      ).rejects.toThrow('the call names another host as its caller')
    }
    expect(publisher.git).not.toHaveBeenCalled()
    expect(publisher.stop).not.toHaveBeenCalled()
  })

  it('refuses a second start during preparation and an existing local publish before pulling', async () => {
    const { mac, publisher, log, finish } = setup()
    log.setStatus({ ...log.status, phase: 'running' })
    await expect(mac.handle('publish.start', params, context())).rejects.toThrow(
      'a publish is already running'
    )
    expect(publisher.git).not.toHaveBeenCalled()
    finish(0)
    const first = mac.handle('publish.start', params, context())
    await expect(mac.handle('publish.start', params, context())).rejects.toThrow(
      'a publish is already running'
    )
    await vi.waitFor(() => expect(publisher.publish).toHaveBeenCalled())
    finish(0)
    await first
  })

  it('stops the Publisher and settles the waiting call', async () => {
    const { mac, publisher } = setup()
    const run = mac.handle('publish.start', params, context())
    await vi.waitFor(() => expect(publisher.publish).toHaveBeenCalled())
    await expect(
      mac.handle('publish.stop', { caller: params.caller, args: {} }, context())
    ).resolves.toEqual({ stopped: true })
    expect(publisher.stop).toHaveBeenCalledOnce()
    await expect(run).resolves.toMatchObject({ ok: false, exit: 143 })
  })

  it('takes only publish pushes and sends the outcome through the peer link', async () => {
    const { mac, publisher, replies } = setup()
    expect(macPublishOffers()).toEqual(['publish'])
    expect(
      mac.onPeerPush(BOX, {
        push: 'peer.call',
        callId: 'x',
        method: 'thread.list',
        params: {} as never,
        deadlineMs: 1000
      })
    ).toBe(false)
    expect(
      mac.onPeerPush(BOX, {
        push: 'peer.call',
        callId: 'x',
        method: 'publish.stop',
        params: { caller: params.caller, args: {} },
        deadlineMs: 1000
      })
    ).toBe(true)
    await vi.waitFor(() =>
      expect(replies).toContainEqual({
        method: 'peer.reply',
        params: { callId: 'x', ok: true, result: { stopped: true } }
      })
    )
    expect(publisher.stop).toHaveBeenCalledOnce()
  })

  it('does not start a publish whose deadline passed during the pull', async () => {
    const { mac, publisher } = setup()
    await expect(
      mac.handle('publish.start', params, { ...context(), deadlineAt: Date.now() - 1 })
    ).rejects.toThrow('the publish deadline passed')
    expect(publisher.publish).not.toHaveBeenCalled()
  })

  it('cleans up its subscription if the call deadline passes', async () => {
    const { mac, log } = setup()
    await expect(
      mac.handle('publish.start', params, { ...context(), deadlineAt: Date.now() + 20 })
    ).rejects.toThrow('the publish deadline passed')
    expect(log.subscriberCount).toBe(0)
  })
})
