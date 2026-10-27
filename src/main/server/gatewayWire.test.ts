import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configure } from 'aliax-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Calls, GatewayControlTimeout, WireGone, type AccountsState, type ChildEvent, type MainCall, type WireMessage } from './gatewayWire'
import { PortControl } from './gatewayChild'
import { GatewayCore } from './gatewayCore'
import { Upstream } from './upstream'
import { classifyFailure, networkRefusalOf, refusalCodeOf } from './failureKind'

const state: AccountsState = { profiles: { 'claude-code': ['a'] }, pinned: { 'claude-code': 'a' }, reports: {}, out: [] }
const credential: MainCall = { m: 'credentialFor', service: 'claude', account: 'a' }

afterEach(() => vi.useRealTimers())

describe('gateway control deadlines', () => {
  it('a credential ask expires after 30 s and leaves no pending entry; a late reply cannot settle another ask', async () => {
    vi.useFakeTimers()
    const posted: WireMessage[] = []
    const calls = new Calls<MainCall>({ post: (m) => { posted.push(m) } })
    const first = calls.call(credential)
    const failed = expect(first).rejects.toMatchObject({ name: 'GatewayControlTimeout', method: 'credentialFor', timeoutMs: 30_000 })
    await vi.advanceTimersByTimeAsync(29_999)
    expect((Reflect.get(calls, 'pending') as Map<number, unknown>).size).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await failed
    expect((Reflect.get(calls, 'pending') as Map<number, unknown>).size).toBe(0)
    calls.settle({ t: 'reply', id: 1, ok: true, value: 'late' })
    const next = calls.call(credential)
    expect(posted).toHaveLength(2)
    calls.settle({ t: 'reply', id: 2, ok: true, value: 'fresh' })
    expect(await next).toBe('fresh')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('accepts a shorter deadline and clears timers on a reply, a closed wire and a failed post', async () => {
    vi.useFakeTimers()
    const calls = new Calls<MainCall>({ post: () => {} })
    const expired = calls.call({ m: 'usage', serviceId: 'codex', force: false }, { timeoutMs: 15 })
    const failed = expect(expired).rejects.toBeInstanceOf(GatewayControlTimeout)
    await vi.advanceTimersByTimeAsync(15)
    await failed
    const replied = calls.call(credential)
    calls.settle({ t: 'reply', id: 2, ok: false, error: 'refused' })
    await expect(replied).rejects.toThrow('refused')
    const lost = calls.call(credential)
    calls.failAll(new WireGone())
    await expect(lost).rejects.toBeInstanceOf(WireGone)
    await expect(new Calls<MainCall>({ post: () => { throw new Error('closed') } }).call(credential)).rejects.toThrow('closed')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a timed-out coalesced credential ask leaves asking so the next miss asks again', async () => {
    vi.useFakeTimers()
    const posted: WireMessage[] = []
    const calls = new Calls<MainCall>({ post: (m) => { posted.push(m) } })
    const control = new PortControl(calls, () => {}, state)
    const misses = Promise.allSettled([control.credentialFor('claude', 'a'), control.credentialFor('claude', 'a')])
    expect(posted).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(30_000)
    for (const result of await misses) {
      expect(result.status).toBe('rejected')
      if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(GatewayControlTimeout)
    }
    const retry = control.credentialFor('claude', 'a')
    expect(posted).toHaveLength(2)
    calls.settle({ t: 'reply', id: 2, ok: true, value: { authorization: 'Bearer fresh' } })
    expect(await retry).toEqual({ authorization: 'Bearer fresh' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('the gateway answers a credential timeout with 503 and a code the failure classifier reads as network', async () => {
    const events: ChildEvent[] = []
    const control = new PortControl({ call: () => Promise.reject(new GatewayControlTimeout('credentialFor', 30_000)) }, (e) => events.push(e), state)
    const core = new GatewayCore({ control, tls: null })
    try {
      await core.listen()
      const response = await fetch(`${core.url('claude')}/~t=credential-test;a=a/v1/messages`, { method: 'POST', body: '{}' })
      expect(response.status).toBe(503)
      const body = await response.text()
      expect(refusalCodeOf(body)).toBe('credential_timeout')
      expect(events.find((e) => e.e === 'network')).toMatchObject({ info: { error: expect.stringContaining('credential_timeout') } })
      expect(classifyFailure({ message: body, provider: 'claude', model: null, account: 'a', accountKnown: true, modelVisible: true })).toMatchObject({
        kind: 'network', summary: 'The gateway could not get a credential in time'
      })
    } finally {
      await core.close()
    }
  })
})


it('a provider body deadline ends the forwarded body and reaches the existing network hook with its stage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-gateway-deadline-'))
  const upstream = new Upstream({
    chromiumFetch: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: ping\n\n')) }
    })),
    pooled: () => false,
    bodyIdleMs: 20
  })
  configure({ dataDir: dir, fetch: upstream.fetch, secrets: { mode: 'fileKey' } })
  const events: ChildEvent[] = []
  const control = new PortControl({ call: () => Promise.reject(new Error('no control RPC expected')) }, (e) => events.push(e), state)
  vi.spyOn(control, 'credentialFor').mockResolvedValue({ authorization: 'Bearer test' })
  const core = new GatewayCore({ control, tls: null })
  try {
    await core.listen()
    const response = await fetch(`${core.url('claude')}/~t=body-test;a=a/v1/messages`, { method: 'POST', body: '{}' })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('data: ping\n\n')
    const network = events.find((e) => e.e === 'network')
    expect(network).toMatchObject({ info: { error: 'Upstream body timed out after 20 ms' } })
    if (network?.e !== 'network') throw new Error('missing network record')
    expect(networkRefusalOf(network.info)).toMatchObject({ thread: 'body-test', refusal: { timeout: { stage: 'body', timeoutMs: 20 } } })
  } finally {
    await core.close()
    await upstream.destroy()
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  }
})
