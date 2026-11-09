import { describe, expect, it, vi } from 'vitest'
import type { AddonSpec } from '@shared/contract-addons'
import { probeFields } from './grantProbe'

const http: AddonSpec = { transport: 'http', url: 'https://mcp.example.com/mcp', headers: ['X-Api-Key', 'X-Team'], auth: 'fields' }
const answering = (status: number) => vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status }))

describe('probeFields', () => {
  it('posts one initialize to the url with the headers the values name', async () => {
    const fetch = answering(200)
    expect(await probeFields(http, { 'X-Api-Key': 'k1', 'X-Team': 'design', Other: 'x' }, fetch)).toBe('ok')
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('https://mcp.example.com/mcp')
    expect(init!.method).toBe('POST')
    const headers = init!.headers as Record<string, string>
    expect(headers['X-Api-Key']).toBe('k1')
    expect(headers['X-Team']).toBe('design')
    expect(headers.Other).toBeUndefined()
    expect(JSON.parse(String(init!.body))).toMatchObject({ jsonrpc: '2.0', method: 'initialize' })
  })

  it('a 401 or 403 is refused; a 2xx ok; a 500, a 429 and a network failure unknown', async () => {
    expect(await probeFields(http, {}, answering(401))).toBe('refused')
    expect(await probeFields(http, {}, answering(403))).toBe('refused')
    expect(await probeFields(http, {}, answering(202))).toBe('ok')
    expect(await probeFields(http, {}, answering(500))).toBe('unknown')
    expect(await probeFields(http, {}, answering(429))).toBe('unknown')
    const down = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    expect(await probeFields(http, {}, down)).toBe('unknown')
  })

  it('gives up at its deadline', async () => {
    const hang = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted')))))
    expect(await probeFields(http, {}, hang, 20)).toBe('unknown')
  })

  it('a stdio add-on has no health call', async () => {
    const fetch = answering(200)
    expect(await probeFields({ transport: 'stdio', command: 'npx', args: [], env: ['K'], auth: 'fields' }, { K: 'v' }, fetch)).toBe('unknown')
    expect(fetch).not.toHaveBeenCalled()
  })
})
