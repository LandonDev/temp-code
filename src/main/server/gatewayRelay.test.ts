import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configure } from 'aliax-core'
import { afterEach, expect, it, vi } from 'vitest'
import type { AccountsState, ChildEvent } from './gatewayWire'
import { PortControl } from './gatewayChild'
import { GatewayCore } from './gatewayCore'
import { Upstream } from './upstream'

/**
 * The relay between a CLI and the provider, through the real GatewayCore
 * over an Upstream whose provider is a stream this file writes: how a
 * request ends when its client hangs up.
 */
const state: AccountsState = { profiles: { 'claude-code': ['a'] }, pinned: { 'claude-code': 'a' }, reports: {}, out: [] }
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
  vi.restoreAllMocks()
})
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** A gateway whose upstream answers every request with `body`, and the child events it raised. */
async function gatewayOver(body: (signal: AbortSignal | undefined) => ReadableStream<Uint8Array>): Promise<{ core: GatewayCore; events: ChildEvent[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'tc-gateway-relay-'))
  const upstream = new Upstream({
    chromiumFetch: async (_url, init) => new Response(body(init?.signal ?? undefined), { headers: { 'content-type': 'text/event-stream' } }),
    pooled: () => false
  })
  configure({ dataDir: dir, fetch: upstream.fetch, secrets: { mode: 'fileKey' } })
  const events: ChildEvent[] = []
  const control = new PortControl({ call: () => Promise.reject(new Error('no control RPC expected')) }, (e) => events.push(e), state)
  vi.spyOn(control, 'credentialFor').mockResolvedValue({ authorization: 'Bearer test' })
  const core = new GatewayCore({ control, tls: null })
  await core.listen()
  cleanups.push(async () => {
    await core.close()
    await upstream.destroy()
    rmSync(dir, { recursive: true, force: true })
  })
  return { core, events }
}

/** A provider stream: one SSE event every `everyMs`, `count` of them (forever when null); `cancelled` once its reader goes. */
function ticking(everyMs: number, count: number | null): { stream: (signal?: AbortSignal) => ReadableStream<Uint8Array>; cancelled: () => boolean } {
  let cancelled = false
  return {
    cancelled: () => cancelled,
    stream: (signal) => {
      let timer: ReturnType<typeof setInterval> | undefined
      let n = 0
      signal?.addEventListener('abort', () => {
        cancelled = true
        clearInterval(timer)
      })
      return new ReadableStream({
        start(controller) {
          timer = setInterval(() => {
            controller.enqueue(new TextEncoder().encode(`event: content_block_delta\ndata: {"n":${n}}\n\n`))
            if (count !== null && ++n >= count) {
              clearInterval(timer)
              controller.close()
            }
          }, everyMs)
        },
        cancel() {
          cancelled = true
          clearInterval(timer)
        }
      })
    }
  }
}

const requestEvents = (events: ChildEvent[], phase: 'start' | 'end'): ChildEvent[] =>
  events.filter((e) => e.e === 'request' && e.phase === phase)

it('a client that hangs up mid-answer ends its request at once and cancels the upstream, with no network record', async () => {
  const provider = ticking(20, null)
  const { core, events } = await gatewayOver(provider.stream)
  const url = new URL(`${core.url('claude')}/~t=hangup-test;a=a/v1/messages`)
  await new Promise<void>((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST' }, (res) => {
      res.once('data', () => {
        // The CLI's Stop: the socket goes with the answer still streaming.
        req.destroy()
        resolve()
      })
    })
    req.on('error', () => {})
    req.once('error', reject)
    req.end('{}')
  })
  expect(requestEvents(events, 'start')).toHaveLength(1)
  // The provider keeps streaming; before, core's relay waited for a 'drain' that never came and the request never ended.
  for (let i = 0; i < 50 && requestEvents(events, 'end').length === 0; i++) await sleep(10)
  expect(requestEvents(events, 'end')).toEqual([{ e: 'request', phase: 'end', info: expect.objectContaining({ thread: 'hangup-test' }) }])
  for (let i = 0; i < 50 && !provider.cancelled(); i++) await sleep(10)
  expect(provider.cancelled()).toBe(true)
  // A hang-up is the client's word, not a provider failure.
  expect(events.filter((e) => e.e === 'network' || e.e === 'error')).toEqual([])
})
