import { createServer } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { SIGNIN_TIMEOUT } from '@shared/addonGrantWords'
import { callbackCsp, NOT_FINISHED_LINE, oauthCallback, SIGNED_IN_LINE, type CallbackServer } from './oauthCallback'

const open: CallbackServer[] = []
afterEach(async () => {
  while (open.length) await open.pop()!.close()
})
const listen = async (state = 'S1', opts: Parameters<typeof oauthCallback>[2] = {}): Promise<CallbackServer> => {
  const cb = await oauthCallback(0, state, { name: 'Mobbin', ...opts })
  open.push(cb)
  return cb
}
const get = (cb: CallbackServer, path: string, method = 'GET') => fetch(`http://127.0.0.1:${cb.port}${path}`, { method })

describe('oauthCallback', () => {
  it('binds 127.0.0.1 only, on the port the OS gives, never below 1024', async () => {
    const cb = await listen()
    expect(cb.port).toBeGreaterThanOrEqual(1024)
    await expect(fetch(`http://localhost:${cb.port}/nothing`).then((r) => r.status)).resolves.toBe(404)
    // Nothing answers on another address of this machine.
    const { networkInterfaces } = await import('node:os')
    const other = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address
    if (other) await expect(fetch(`http://${other}:${cb.port}/callback`, { signal: AbortSignal.timeout(2_000) })).rejects.toThrow()
  })

  it('answers 404 for any other path or method', async () => {
    const cb = await listen()
    expect((await get(cb, '/')).status).toBe(404)
    expect((await get(cb, '/callback/x?state=S1&code=c')).status).toBe(404)
    expect((await get(cb, '/callback?state=S1&code=c', 'POST')).status).toBe(404)
  })

  it('takes only a callback carrying its state, success or error alike; the rest see the failure page and it keeps waiting', async () => {
    const cb = await listen('right')
    const next = cb.next(new AbortController().signal)
    const wrongCode = await get(cb, '/callback?state=wrong&code=stolen')
    expect(wrongCode.status).toBe(400)
    expect(await wrongCode.text()).toContain(NOT_FINISHED_LINE)
    const wrongError = await get(cb, '/callback?state=wrong&error=access_denied')
    expect(wrongError.status).toBe(400)
    const missing = await get(cb, '/callback?code=c')
    expect(missing.status).toBe(400)
    const ok = await get(cb, '/callback?state=right&code=THE_CODE')
    expect(ok.status).toBe(200)
    const body = await ok.text()
    expect(body).toContain(SIGNED_IN_LINE('Mobbin'))
    expect(body).not.toContain('THE_CODE')
    expect(ok.headers.get('content-security-policy')).toMatch(/^default-src 'none'; style-src 'nonce-/)
    expect(ok.headers.get('content-security-policy')).not.toContain('unsafe-inline')
    await expect(next).resolves.toEqual({ code: 'THE_CODE' })
    // It closed after the first matching callback.
    await expect(get(cb, '/callback?state=right&code=again')).rejects.toThrow()
  })

  it('a matching error is the answer, with its description', async () => {
    const cb = await listen('s')
    const page = await get(cb, '/callback?state=s&error=access_denied&error_description=The%20user%20said%20no')
    expect(await page.text()).toContain(NOT_FINISHED_LINE)
    await expect(cb.next(new AbortController().signal)).resolves.toEqual({ error: 'access_denied', description: 'The user said no' })
  })

  it('closes on abort and at the timeout', async () => {
    const cb = await listen()
    const ctl = new AbortController()
    const waiting = cb.next(ctl.signal)
    ctl.abort()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    await expect(get(cb, '/callback?state=S1&code=c')).rejects.toThrow()
    const slow = await listen('S2', { timeoutMs: 30 })
    await expect(slow.next(new AbortController().signal)).rejects.toThrow(SIGNIN_TIMEOUT)
  })

  it('a port in use fails with EADDRINUSE for the caller to word', async () => {
    const holder = createServer()
    await new Promise<void>((r) => holder.listen(0, '127.0.0.1', r))
    const port = (holder.address() as { port: number }).port
    await expect(oauthCallback(port, 's')).rejects.toMatchObject({ code: 'EADDRINUSE' })
    holder.close()
  })

  it("the page's policy names its nonce", () => {
    expect(callbackCsp('abc')).toBe("default-src 'none'; style-src 'nonce-abc'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
  })
})
