import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import type { AddonSpec } from '@shared/contract-addons'
import { wirePair } from './testWire'
import { runAddonChild, type AddonChild, type DownstreamLike } from './addonChild'
import type { AddonCallResult, AddonChildEvent, AddonLaunch, AddonWireMessage, ResolvedGrant } from './addonWire'

const FAKE = fileURLToPath(new URL('../../../../scripts/lib/fakeMcpServer.ts', import.meta.url))
const RUN = process.versions.bun ? [] : ['--no-warnings']
const dir = mkdtempSync(join(tmpdir(), 'tc-addon-child-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const spec: AddonSpec = { transport: 'stdio', command: process.execPath, args: [...RUN, FAKE, '--stdio'], env: ['FAKE_TOKEN'], auth: 'fields' }
const launch = (id: string, digest = 'd1'): AddonLaunch => ({ id, name: id.replace('ad_', ''), spec, specDigest: digest })

let child: AddonChild | null = null
afterEach(async () => {
  await child?.stop()
  child = null
})

function harness(opts: { make?: (deps: Parameters<NonNullable<Parameters<typeof runAddonChild>[1]>['make'] & {}>[0]) => DownstreamLike; grant?: (id: string) => ResolvedGrant } = {}) {
  const [main, other] = wirePair<AddonWireMessage>()
  const events: AddonChildEvent[] = []
  const grantAsks: string[] = []
  let exited = 0
  let nextId = 1
  const pending = new Map<number, (v: unknown) => void>()
  main.onMessage((m) => {
    if (m.t === 'event') events.push(m.event)
    if (m.t === 'ask' && m.call.m === 'grant') {
      grantAsks.push(m.call.addonId)
      const value = (opts.grant ?? (() => ({ ok: true, env: { FAKE_TOKEN: 'v1' }, headers: {}, digest: 'g1' })))(m.call.addonId)
      main.post({ t: 'reply', id: m.id, ok: true, value })
    }
    if (m.t === 'reply') pending.get(m.id)?.(m.ok ? m.value : m.error)
  })
  child = runAddonChild(other, { exit: () => exited++, watchMainMs: 0, downstream: { backoffMs: [50] }, ...(opts.make ? { make: opts.make } : {}) })
  const ask = (call: Extract<AddonWireMessage, { t: 'ask' }>['call']) =>
    new Promise<unknown>((resolve) => {
      const id = nextId++
      pending.set(id, resolve)
      main.post({ t: 'ask', id, call })
    })
  const start = (launches: AddonLaunch[]) =>
    main.post({ t: 'start', state: { mainPid: process.pid, baseEnv: { PATH: process.env.PATH ?? '' }, cwd: dir, launches, trace: false } })
  const ready = (id: string) => events.filter((e) => e.e === 'status' && e.addonId === id && e.status.state === 'ready').length
  return { main, events, grantAsks, start, ask, ready, exited: () => exited }
}

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('runAddonChild', () => {
  it('starts each launch, stops one that left and restarts one whose spec changed', async () => {
    const h = harness()
    h.start([launch('ad_a'), launch('ad_b')])
    await until(() => h.ready('ad_a') === 1 && h.ready('ad_b') === 1)
    expect(h.events.find((e) => e.e === 'tools' && e.addonId === 'ad_a')).toMatchObject({ specDigest: 'd1' })
    expect(child!.running().sort()).toEqual(['ad_a', 'ad_b'])
    h.main.post({ t: 'launches', launches: [launch('ad_a', 'd2')] })
    await until(() => h.ready('ad_a') === 2)
    expect(child!.running()).toEqual(['ad_a'])
    expect(h.events.filter((e) => e.e === 'tools' && e.addonId === 'ad_a').at(-1)).toMatchObject({ specDigest: 'd2' })
    const echoed = (await h.ask({ m: 'call', addonId: 'ad_a', tool: 'echo', arguments: { text: 'hi' }, callId: 'c1', timeoutMs: 5_000 })) as AddonCallResult
    expect(echoed.content).toEqual([{ type: 'text', text: 'hi' }])
    const missing = (await h.ask({ m: 'call', addonId: 'ad_b', tool: 'echo', arguments: {}, callId: 'c2', timeoutMs: 5_000 })) as AddonCallResult
    expect(missing.isError).toBe(true)
  })

  it('asks for the grant at connect and again after grants.drop', async () => {
    let token = 'v1'
    const h = harness({ grant: () => ({ ok: true, env: { FAKE_TOKEN: token }, headers: {}, digest: token }) })
    h.start([launch('ad_a')])
    await until(() => h.ready('ad_a') === 1)
    expect(h.grantAsks).toEqual(['ad_a'])
    token = 'v2'
    h.main.post({ t: 'grants.drop', addonId: null })
    await until(() => h.grantAsks.length === 2 && h.ready('ad_a') === 2)
  })

  it('a client that throws reads failed and the others keep serving; a cancel aborts the call', async () => {
    let aborted = false
    const quiet: DownstreamLike = {
      start: () => {},
      close: async () => {},
      restart: async () => {},
      grantsDropped: async () => {},
      call: (_t, _a, { signal }) =>
        new Promise<AddonCallResult>((resolve) =>
          signal?.addEventListener('abort', () => {
            aborted = true
            resolve({ content: [], isError: true })
          })
        )
    }
    const h = harness({
      make: (deps) => {
        if (deps.launch.id === 'ad_bad') throw new Error('broken client')
        return quiet
      }
    })
    h.start([launch('ad_bad'), launch('ad_good')])
    await until(() => h.events.length >= 1)
    expect(h.events[0]).toMatchObject({ e: 'status', addonId: 'ad_bad', status: { state: 'failed', detail: "The add-on's client failed: broken client" } })
    expect(child!.running()).toEqual(['ad_good'])
    const slow = h.ask({ m: 'call', addonId: 'ad_good', tool: 'slow', arguments: {}, callId: 'c9', timeoutMs: 5_000 })
    await new Promise((r) => setTimeout(r, 20))
    await h.ask({ m: 'cancel', callId: 'c9' })
    await slow
    expect(aborted).toBe(true)
  })

  it('an uncaught error naming a client fails it alone; any other ends the process; a closed port ends it', async () => {
    const h = harness({ make: () => ({ start: () => {}, close: async () => {}, restart: async () => {}, grantsDropped: async () => {}, call: async () => ({ content: [] }) }) })
    h.start([launch('ad_a'), launch('ad_b')])
    await until(() => child!.running().length === 2)
    child!.uncaught(new Error('boom in ad_a'))
    await until(() => h.events.some((e) => e.e === 'status' && e.addonId === 'ad_a'))
    expect(child!.running()).toEqual(['ad_b'])
    expect(h.exited()).toBe(0)
    child!.uncaught(new Error('somewhere else'))
    expect(h.exited()).toBe(1)
    h.main.close()
    expect(h.exited()).toBe(2)
  })
})
