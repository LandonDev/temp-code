import { createHmac } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Notice } from './notifier'
import {
  WEBHOOK_ATTEMPTS,
  checkWebhookUrl,
  deliverWebhooks,
  pinnedPoster,
  signPayload,
  webhookPayload
} from './webhooks'

/** A stub lookup: every name is one public address. */
const publicHost = { resolve: async () => [{ address: '93.184.216.34', family: 4 }] }

const notice: Notice = {
  event: 'finished',
  threadId: 't1',
  title: 'Ship it',
  body: 'Finished its turn',
  url: 'https://tc.example/ui#thread=t1',
  ts: 1_760_000_000_000
}

describe('payload and signature', () => {
  it('is the hub body, signed over the exact bytes', () => {
    const payload = webhookPayload(notice, 'box')
    expect(payload).toEqual({
      event: 'finished',
      hostId: 'box',
      threadId: 't1',
      title: 'Ship it',
      body: 'Finished its turn',
      url: 'https://tc.example/ui#thread=t1',
      ts: 1_760_000_000_000
    })
    expect(webhookPayload({ ...notice, url: undefined }, 'box')).not.toHaveProperty('url')
    const body = JSON.stringify(payload)
    expect(signPayload(body, 's3cret')).toBe(
      `sha256=${createHmac('sha256', 's3cret').update(body).digest('hex')}`
    )
  })
  it('takes https to a public host, and nothing with credentials', async () => {
    expect(await checkWebhookUrl('https://bot.example/hook', publicHost)).toBe('https://bot.example/hook')
    await expect(checkWebhookUrl('http://bot.example/hook', publicHost)).rejects.toThrow(/must be https/)
    await expect(checkWebhookUrl('https://u:p@bot.example/hook', publicHost)).rejects.toThrow(/credentials/)
    await expect(checkWebhookUrl('nope', publicHost)).rejects.toThrow(/not a URL/)
  })
  it('refuses loopback, private, link-local, unique-local and metadata targets (R2 M3)', async () => {
    for (const url of [
      'http://127.0.0.1:9/hook',
      'https://127.0.0.1/hook',
      'http://localhost:9/hook',
      'https://10.0.0.1/hook',
      'https://172.16.5.5/hook',
      'https://192.168.0.10/hook',
      'https://169.254.169.254/latest/meta-data/',
      'https://[::1]/hook',
      'https://[fe80::1]/hook',
      'https://[fc00::1]/hook',
      'https://[fd00:ec2::254]/hook',
      'https://[::ffff:10.0.0.1]/hook',
      'https://metadata.google.internal/computeMetadata/v1/',
      'https://2130706433/hook', // 127.0.0.1 in decimal: the URL parser canonicalises it
      'https://0x7f000001/hook'
    ])
      await expect(checkWebhookUrl(url, publicHost), url).rejects.toThrow(/private or local/)
    // A name that resolves to a private address is refused like a literal; one private record is enough.
    await expect(checkWebhookUrl('https://bot.example/hook', { resolve: async () => [{ address: '10.0.0.5', family: 4 }] })).rejects.toThrow(/private or local/)
    await expect(checkWebhookUrl('https://bot.example/hook', { resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }] })).rejects.toThrow(/private or local/)
    await expect(checkWebhookUrl('https://bot.example/hook', { resolve: async () => [] })).rejects.toThrow(/does not resolve/)
  })
  it('lets a loopback http receiver through only with the test seam', async () => {
    expect(await checkWebhookUrl('http://127.0.0.1:9/hook', { allowLoopback: true })).toBe('http://127.0.0.1:9/hook')
    await expect(checkWebhookUrl('https://169.254.169.254/x', { allowLoopback: true })).rejects.toThrow(/private or local/)
    await expect(checkWebhookUrl('http://127.0.0.1:9/hook', {})).rejects.toThrow(/private or local/)
  })
})

describe('pinnedPoster', () => {
  let receiver: Server
  let port = 0
  const got: { method: string; url: string; body: string }[] = []
  beforeAll(async () => {
    receiver = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        got.push({ method: req.method!, url: req.url!, body: Buffer.concat(chunks).toString() })
        if (req.url === '/redirect') res.writeHead(302, { Location: '/elsewhere' })
        else res.writeHead(204)
        res.end()
      })
    })
    await new Promise<void>((ok) => receiver.listen(0, '127.0.0.1', ok))
    port = (receiver.address() as { port: number }).port
  })
  afterAll(() => receiver.close())
  const init = (): Parameters<ReturnType<typeof pinnedPoster>>[1] => ({
    method: 'POST',
    redirect: 'error',
    signal: new AbortController().signal,
    headers: { 'content-type': 'application/json' },
    body: '{"x":1}'
  })
  it('posts to a loopback receiver when loopback is allowed and never follows a redirect', async () => {
    const post = pinnedPoster({ allowLoopback: true })
    expect(await post(`http://127.0.0.1:${port}/hook`, init())).toMatchObject({ ok: true, status: 204 })
    expect(got.at(-1)).toEqual({ method: 'POST', url: '/hook', body: '{"x":1}' })
    expect(await post(`http://127.0.0.1:${port}/redirect`, init())).toMatchObject({ ok: false, status: 302 })
    expect(got.filter((g) => g.url === '/elsewhere')).toHaveLength(0)
  })
  it('refuses the connect itself when the guard says no, so nothing reaches the receiver', async () => {
    const before = got.length
    await expect(pinnedPoster({})(`http://127.0.0.1:${port}/hook`, init())).rejects.toMatchObject({ code: 'EREFUSEDTARGET' })
    // A name whose answer moved to a private address since the key was made (DNS rebinding).
    await expect(pinnedPoster({ resolve: async () => [{ address: '127.0.0.1', family: 4 }] })(`http://bot.example:${port}/hook`, init())).rejects.toMatchObject({ code: 'EREFUSEDTARGET' })
    expect(got.length).toBe(before)
    const lines: string[] = []
    const out = await deliverWebhooks([{ keyId: 'k', name: 'n', url: `http://127.0.0.1:${port}/hook`, secret: 's' }], webhookPayload(notice, 'box'), { log: (l) => lines.push(l), sleep: async () => {} })
    expect(out).toEqual({ delivered: 0, failed: 1 })
    expect(lines).toEqual(['webhook k (n) failed: EREFUSEDTARGET'])
    expect(got.length).toBe(before)
  })
})

describe('deliverWebhooks', () => {
  const target = { keyId: 'k1', name: 'grok', url: 'https://bot.example/hook', secret: 'shared' }
  const calls: { url: string; init: RequestInit }[] = []
  const fetchWith = (answers: (() => Response | Promise<Response>)[]): typeof fetch => {
    let i = 0
    return async (url, init) => {
      calls.push({ url: String(url), init: init! })
      const answer = answers[Math.min(i++, answers.length - 1)]
      return answer()
    }
  }
  it('posts the signed body with a delivery id, once when it lands', async () => {
    calls.length = 0
    const lines: string[] = []
    const out = await deliverWebhooks([target], webhookPayload(notice, 'box'), {
      fetch: fetchWith([() => new Response(null, { status: 204 })]),
      log: (l) => lines.push(l)
    })
    expect(out).toEqual({ delivered: 1, failed: 0 })
    expect(calls.length).toBe(1)
    const headers = calls[0].init.headers as Record<string, string>
    const body = calls[0].init.body as string
    expect(JSON.parse(body)).toMatchObject({ event: 'finished', hostId: 'box', threadId: 't1' })
    expect(headers['x-hub-signature-256']).toBe(signPayload(body, 'shared'))
    expect(headers['x-hub-delivery']).toMatch(/^[0-9a-f-]{36}$/)
    expect(calls[0].init.redirect).toBe('error')
    expect(lines).toEqual([])
  })
  it('retries once with the same delivery id, then logs the failure by key id', async () => {
    calls.length = 0
    const lines: string[] = []
    const retried = await deliverWebhooks([target], webhookPayload(notice, 'box'), {
      fetch: fetchWith([
        () => new Response('', { status: 503 }),
        () => new Response('', { status: 200 })
      ]),
      log: (l) => lines.push(l),
      sleep: async () => {}
    })
    expect(retried).toEqual({ delivered: 1, failed: 0 })
    expect(calls.length).toBe(2)
    expect((calls[0].init.headers as Record<string, string>)['x-hub-delivery']).toBe(
      (calls[1].init.headers as Record<string, string>)['x-hub-delivery']
    )
    calls.length = 0
    const failed = await deliverWebhooks(
      [target, { ...target, keyId: 'k2', name: 'gpt', url: 'https://other.example/x' }],
      webhookPayload(notice, 'box'),
      {
        fetch: fetchWith([() => new Response('', { status: 500 })]),
        log: (l) => lines.push(l),
        sleep: async () => {}
      }
    )
    expect(failed).toEqual({ delivered: 0, failed: 2 })
    expect(calls.length).toBe(2 * WEBHOOK_ATTEMPTS)
    expect(lines).toEqual(
      expect.arrayContaining([
        'webhook k1 (grok) failed: HTTP 500',
        'webhook k2 (gpt) failed: HTTP 500'
      ])
    )
    expect(lines.join('\n')).not.toContain('bot.example')
  })
  it('counts a thrown fetch as a failure with its code', async () => {
    const lines: string[] = []
    const fetch = vi.fn(async () => {
      throw Object.assign(new Error('nope'), { code: 'ECONNREFUSED' })
    }) as unknown as typeof globalThis.fetch
    expect(
      await deliverWebhooks([target], webhookPayload(notice, 'box'), {
        fetch,
        log: (l) => lines.push(l),
        sleep: async () => {}
      })
    ).toEqual({ delivered: 0, failed: 1 })
    expect(lines).toEqual(['webhook k1 (grok) failed: ECONNREFUSED'])
  })
})
