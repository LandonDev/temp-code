import { describe, expect, it } from 'vitest'
import type { ServerResponse } from 'node:http'
import { HeldResponse } from './gateway'

/** A ServerResponse stand-in that records what reaches the client. */
function fakeRes(): ServerResponse & { sent: { status: number | null; body: string; ended: boolean } } {
  const sent = { status: null as number | null, body: '', ended: false }
  const res = {
    sent,
    headersSent: false,
    writeHead(status: number) {
      sent.status = status
      res.headersSent = true
      return res
    },
    write(chunk: Buffer | string) {
      sent.body += chunk.toString()
      return true
    },
    end(data?: Buffer | string) {
      if (data) sent.body += data.toString()
      sent.ended = true
      return res
    },
    once() {
      return res
    }
  }
  return res as unknown as ServerResponse & { sent: typeof sent }
}

describe('HeldResponse', () => {
  it("holds a 401 whole so its body can name the refusal's code, then flushes it as it came", () => {
    const res = fakeRes()
    const held = new HeldResponse(res)
    held.writeHead(401, { 'content-type': 'application/json' })
    held.write('{"error":{"code":"token_exp')
    held.end('ired","message":"token expired"}}')
    expect(res.sent.status).toBeNull()
    expect(held.heldText()).toBe('{"error":{"code":"token_expired","message":"token expired"}}')
    held.flush()
    expect(res.sent).toEqual({ status: 401, body: '{"error":{"code":"token_expired","message":"token expired"}}', ended: true })
  })

  it('anything but a 401 streams straight through and has no held text', () => {
    const res = fakeRes()
    const held = new HeldResponse(res)
    held.writeHead(200, {})
    held.write('ok')
    held.end()
    expect(held.heldText()).toBeUndefined()
    expect(res.sent).toEqual({ status: 200, body: 'ok', ended: true })
  })

  it('the held text is capped so a long body never rides the hook whole', () => {
    const held = new HeldResponse(fakeRes())
    held.writeHead(401)
    held.end('x'.repeat(10_000))
    expect(held.heldText()?.length).toBe(4096)
  })
})
