import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { Notice } from './notifier'
import {
  WEBHOOK_ATTEMPTS,
  checkWebhookUrl,
  deliverWebhooks,
  signPayload,
  webhookPayload
} from './webhooks'

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
  it('takes https, loopback http, and nothing with credentials', () => {
    expect(checkWebhookUrl('https://bot.example/hook')).toBe('https://bot.example/hook')
    expect(checkWebhookUrl('http://127.0.0.1:9/hook')).toBe('http://127.0.0.1:9/hook')
    expect(() => checkWebhookUrl('http://bot.example/hook')).toThrow(/must be https/)
    expect(() => checkWebhookUrl('https://u:p@bot.example/hook')).toThrow(/credentials/)
    expect(() => checkWebhookUrl('nope')).toThrow(/not a URL/)
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
