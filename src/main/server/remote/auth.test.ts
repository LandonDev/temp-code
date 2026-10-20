import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../db'
import {
  FAILURE_LIMIT,
  PAIRING_TTL_MS,
  RemoteAuth,
  RemoteAuthError,
  SESSION_RENEW_AFTER_MS,
  SESSION_TTL_MS,
  TICKET_TTL_MS,
  normalizePairingCode,
  readCookie
} from './auth'

let dir: string
let db: ReturnType<typeof openDb>
let clock = 1_700_000_000_000
let auth: RemoteAuth

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-auth-'))
  db = openDb(join(dir, 'app.db'))
  clock = 1_700_000_000_000
  auth = new RemoteAuth(db, { now: () => clock })
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const expectStatus = async (fn: () => unknown, status: number, text?: string): Promise<void> => {
  try {
    await fn()
  } catch (err) {
    expect(err).toBeInstanceOf(RemoteAuthError)
    expect((err as RemoteAuthError).status).toBe(status)
    if (text) expect((err as Error).message).toContain(text)
    return
  }
  throw new Error(`expected a ${status}`)
}

describe('keys', () => {
  it('creates, verifies and lists a bearer key; the token is tc_<id>.<secret>', async () => {
    const { key, token } = await auth.createKey({ name: 'iphone', audience: 'client', caps: ['operate'], createdBy: 'local' })
    expect(token.startsWith(`tc_${key.id}.`)).toBe(true)
    expect(key.caps).toEqual(['operate', 'read'])
    expect(key.kind).toBe('bearer')
    const principal = await auth.verifyToken(token)
    expect(principal).toMatchObject({ kind: 'remote', keyId: key.id, name: 'iphone', caps: ['operate', 'read'] })
    expect(auth.listKeys().map((k) => k.id)).toEqual([key.id])
    expect(auth.getKey(key.id)?.lastUsedAt).toBe(clock)
  }, 20_000)
  it('rejects a wrong secret, a foreign id and junk', async () => {
    const { key, token } = await auth.createKey({ name: 'a', audience: 'client', caps: [], createdBy: 'local' })
    expect(await auth.verifyToken(token.slice(0, -2) + 'xx')).toBeNull()
    expect(await auth.verifyToken(`tc_ZZZZZZZZZZ.${token.split('.')[1]}`)).toBeNull()
    expect(await auth.verifyToken('nope')).toBeNull()
    expect(await auth.verifyToken(`tc_${key.id}`)).toBeNull()
  }, 20_000)
  it('revoke drops the memo so a cached token fails at once', async () => {
    const { key, token } = await auth.createKey({ name: 'a', audience: 'client', caps: [], createdBy: 'local' })
    expect(await auth.verifyToken(token)).not.toBeNull()
    const revoked: string[] = []
    auth.onRevoke((id) => revoked.push(id))
    expect(auth.revokeKey(key.id)).toBe(true)
    expect(auth.revokeKey(key.id)).toBe(false)
    expect(await auth.verifyToken(token)).toBeNull()
    expect(revoked).toEqual([key.id])
    expect(auth.listKeys()).toEqual([])
    expect(auth.listKeys({ includeRevoked: true })[0].revokedAt).toBe(clock)
  }, 20_000)
  it('mcp keys are capped at read,operate; approve and admin are a 400', async () => {
    await expectStatus(() => auth.createKey({ name: 'grok', audience: 'mcp', caps: ['approve'], createdBy: 'local' }), 400, 'mcp keys cannot hold approve')
    await expectStatus(() => auth.createKey({ name: 'grok', audience: 'mcp', caps: ['admin'], createdBy: 'local' }), 400)
    const { key } = await auth.createKey({ name: 'grok', audience: 'mcp', caps: ['operate'], createdBy: 'local' })
    expect(key.caps).toEqual(['operate', 'read'])
  }, 20_000)
  it('a key never widens its creator', async () => {
    await expectStatus(
      () => auth.createKey({ name: 'x', audience: 'client', caps: ['admin'], createdBy: 'K', ceiling: ['operate', 'read'] }),
      400,
      'cannot hold admin'
    )
    await expectStatus(() => auth.createKey({ name: '  ', audience: 'client', caps: [], createdBy: 'local' }), 400, 'name')
  })
})

describe('pairings', () => {
  it('a code exchanges once for a key no wider than the pairing', async () => {
    const { pairing, code } = auth.createPairing({ name: 'iphone', audience: 'client', caps: ['operate', 'approve'], createdBy: 'local' })
    expect(code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/)
    expect(pairing.expiresAt).toBe(clock + PAIRING_TTL_MS)
    expect(auth.listPairings().map((p) => p.id)).toEqual([pairing.id])
    const out = await auth.exchange(code.toLowerCase().replace('-', ' '), { kind: 'key', caps: ['operate'] })
    expect(out.kind).toBe('key')
    if (out.kind !== 'key') throw new Error()
    expect(out.key.caps).toEqual(['operate', 'read'])
    expect(out.key.name).toBe('iphone')
    expect(out.key.createdBy).toBe(`pairing:${pairing.id}`)
    expect(await auth.verifyToken(out.token)).not.toBeNull()
    expect(auth.listPairings()).toEqual([])
    await expectStatus(() => auth.exchange(code, { kind: 'key' }), 401)
  }, 20_000)
  it('concurrent redeems of one code mint one key; the loser is a 401 (R2 M1)', async () => {
    const { pairing, code } = auth.createPairing({ name: 'c', audience: 'client', caps: ['operate'], createdBy: 'local' })
    const before = auth.listKeys().length
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => auth.exchange(code, { kind: 'key' })))
    const won = results.filter((r) => r.status === 'fulfilled')
    expect(won).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected' && (r.reason as RemoteAuthError).status === 401)).toHaveLength(4)
    expect(auth.listKeys().length).toBe(before + 1)
    const key = (won[0] as PromiseFulfilledResult<{ key: { id: string } }>).value.key
    expect(auth.consumedBy(pairing.id)).toBe(key.id)
    expect(auth.listPairings()).toEqual([])
  })
  it('a code whose minting failed is not consumed', async () => {
    const { pairing, code } = auth.createPairing({ name: 'c', audience: 'client', caps: [], createdBy: 'local' })
    const original = auth.createKey.bind(auth)
    auth.createKey = async () => {
      throw new Error('scrypt failed')
    }
    await expect(auth.exchange(code, { kind: 'key' })).rejects.toThrow('scrypt failed')
    auth.createKey = original
    expect(auth.consumedBy(pairing.id)).toBeNull()
    expect((await auth.exchange(code, { kind: 'key' })).key.name).toBe('c')
  })
  it('asking for more than the pairing grants fails before the code is consumed', async () => {
    const { code } = auth.createPairing({ name: 'bot', audience: 'client', caps: ['operate'], createdBy: 'local' })
    await expectStatus(() => auth.exchange(code, { kind: 'key', caps: ['approve'] }), 400, 'this pairing cannot hold approve')
    expect(auth.listPairings()).toHaveLength(1)
    const out = await auth.exchange(code, { kind: 'key' })
    expect(out.key.caps).toEqual(['operate', 'read'])
  }, 20_000)
  it('mcp pairings cannot be created over the ceiling and cannot open a session', async () => {
    expect(() => auth.createPairing({ name: 'grok', audience: 'mcp', caps: ['approve'], createdBy: 'local' })).toThrow(RemoteAuthError)
    const { code } = auth.createPairing({ name: 'grok', audience: 'mcp', caps: ['operate'], createdBy: 'local' })
    await expectStatus(() => auth.exchange(code, { kind: 'session' }), 400)
  })
  it('expires after its ttl and can be cancelled', async () => {
    const { pairing, code } = auth.createPairing({ name: 'a', audience: 'client', caps: [], createdBy: 'local' })
    clock += PAIRING_TTL_MS + 1
    await expectStatus(() => auth.exchange(code, { kind: 'key' }), 401)
    expect(auth.listPairings()).toEqual([])
    const second = auth.createPairing({ name: 'b', audience: 'client', caps: [], createdBy: 'local' })
    expect(auth.revokePairing(second.pairing.id)).toBe(true)
    expect(auth.revokePairing(pairing.id)).toBe(true) // expired rows go too
    await expectStatus(() => auth.exchange(second.code, { kind: 'key' }), 401)
  })
  it('normalizes look-alike characters', () => {
    expect(normalizePairingCode('abcd1-olI0x')).toBe('ABCD1011' + '0X')
  })
})

describe('sessions', () => {
  it('a session pairing makes a browser key row and a sliding cookie', async () => {
    const { code } = auth.createPairing({ name: 'Chrome', audience: 'client', caps: ['operate', 'admin'], createdBy: 'local' })
    const out = await auth.exchange(code, { kind: 'session', caps: ['operate'], userAgent: 'UA' })
    if (out.kind !== 'session') throw new Error()
    expect(out.key.kind).toBe('browser')
    expect(out.session.caps).toEqual(['operate', 'read'])
    expect(out.session.expiresAt).toBe(clock + SESSION_TTL_MS)
    const first = auth.verifyCookie(out.cookie)
    expect(first?.principal).toMatchObject({ keyId: out.key.id, caps: ['operate', 'read'], sessionId: out.session.id })
    expect(first?.session?.renewed).toBe(false)
    clock += SESSION_RENEW_AFTER_MS + 1
    const later = auth.verifyCookie(out.cookie)
    expect(later?.session?.renewed).toBe(true)
    expect(auth.listSessions()[0].expiresAt).toBe(clock + SESSION_TTL_MS)
    expect(auth.listSessions()[0].keyName).toBe('Chrome')
    expect(auth.verifyCookie(out.cookie.slice(0, -1) + '!')).toBeNull()
    expect(auth.verifyCookie('nodot')).toBeNull()
  })
  it('expires, and dies with its key', async () => {
    const { code } = auth.createPairing({ name: 'Chrome', audience: 'client', caps: [], createdBy: 'local' })
    const out = await auth.exchange(code, { kind: 'session' })
    if (out.kind !== 'session') throw new Error()
    auth.revokeKey(out.key.id)
    expect(auth.verifyCookie(out.cookie)).toBeNull()
    expect(auth.listSessions()).toEqual([])
    const again = await auth.exchange(auth.createPairing({ name: 'c', audience: 'client', caps: [], createdBy: 'local' }).code, { kind: 'session' })
    if (again.kind !== 'session') throw new Error()
    clock += SESSION_TTL_MS + 1
    expect(auth.verifyCookie(again.cookie)).toBeNull()
  })
  it('revoking the last session of a browser key revokes the key too', async () => {
    const out = await auth.exchange(auth.createPairing({ name: 'c', audience: 'client', caps: [], createdBy: 'local' }).code, { kind: 'session' })
    if (out.kind !== 'session') throw new Error()
    const revoked: string[] = []
    auth.onRevoke((id) => revoked.push(id))
    expect(auth.revokeSession(out.session.id)).toBe(true)
    expect(auth.revokeSession(out.session.id)).toBe(false)
    expect(auth.getKey(out.key.id)?.revokedAt).toBe(clock)
    expect(revoked).toEqual([out.key.id])
  })
})

describe('tickets', () => {
  it('are single use and live 30 seconds', async () => {
    const { token } = await auth.createKey({ name: 'a', audience: 'client', caps: ['operate'], createdBy: 'local' })
    const principal = (await auth.verifyToken(token))!
    const { ticket, expiresIn } = auth.mintTicket(principal)
    expect(expiresIn).toBe(30)
    expect(auth.consumeTicket(ticket)?.keyId).toBe(principal.keyId)
    expect(auth.consumeTicket(ticket)).toBeNull()
    const second = auth.mintTicket(principal).ticket
    clock += TICKET_TTL_MS
    expect(auth.consumeTicket(second)).toBeNull()
    const third = auth.mintTicket(principal).ticket
    auth.revokeKey(principal.keyId)
    expect(auth.consumeTicket(third)).toBeNull()
  }, 20_000)
})

describe('failure limiter', () => {
  it('ten failures in ten minutes lock an ip until the oldest ages out', () => {
    for (let i = 0; i < FAILURE_LIMIT - 1; i++) auth.recordFailure('1.2.3.4')
    expect(auth.retryAfter('1.2.3.4')).toBe(0)
    auth.recordFailure('1.2.3.4')
    expect(auth.retryAfter('1.2.3.4')).toBe(600)
    expect(auth.retryAfter('5.6.7.8')).toBe(0)
    clock += 599_000
    expect(auth.retryAfter('1.2.3.4')).toBe(1)
    clock += 2_000
    expect(auth.retryAfter('1.2.3.4')).toBe(0)
  })
})

describe('principalFor', () => {
  it('reads a bearer, else the cookie; a bad bearer counts as a failure', async () => {
    const { token } = await auth.createKey({ name: 'a', audience: 'client', caps: [], createdBy: 'local' })
    expect((await auth.principalFor({ authorization: `Bearer ${token}` }, 'ip'))?.principal.name).toBe('a')
    await expectStatus(() => auth.principalFor({ authorization: 'Bearer tc_nope.x' }, 'ip'), 401)
    expect(auth.retryAfter('ip')).toBe(0)
    for (let i = 0; i < FAILURE_LIMIT; i++) await auth.principalFor({ authorization: 'Bearer junk' }, 'ip').catch(() => {})
    expect(auth.retryAfter('ip')).toBeGreaterThan(0)
    const out = await auth.exchange(auth.createPairing({ name: 'c', audience: 'client', caps: [], createdBy: 'local' }).code, { kind: 'session' })
    if (out.kind !== 'session') throw new Error()
    expect((await auth.principalFor({ cookie: `other=1; tc_session=${out.cookie}` }, 'ip'))?.session?.id).toBe(out.session.id)
    await expectStatus(() => auth.principalFor({ cookie: 'tc_session=bad.bad' }, 'ip'), 401)
    expect(await auth.principalFor({}, 'ip')).toBeNull()
    expect(readCookie('a=1; b=2', 'b')).toBe('2')
    expect(readCookie(undefined, 'b')).toBeNull()
  }, 20_000)
})

describe('webhooks on keys', () => {
  it('stores a webhook with a generated secret shown once, lists it without the secret, and targets by event', async () => {
    const made = await auth.createKey({ name: 'grok', audience: 'mcp', caps: ['operate'], createdBy: 'local', webhookUrl: 'https://bot.example/hook' })
    expect(made.webhookSecret).toMatch(/^[0-9a-f]{64}$/)
    expect(made.key).toMatchObject({ webhookUrl: 'https://bot.example/hook', events: ['needs_you', 'finished', 'failed', 'stuck'] })
    const listed = auth.listKeys().find((k) => k.id === made.key.id)!
    expect(listed.webhookUrl).toBe('https://bot.example/hook')
    expect(JSON.stringify(listed)).not.toContain(made.webhookSecret)
    const own = await auth.createKey({ name: 'gpt', audience: 'mcp', caps: [], createdBy: 'local', webhookUrl: 'https://other.example/x', webhookSecret: 'my-own-secret', events: ['finished', 'stuck'] })
    expect(own.webhookSecret).toBeUndefined()
    expect(own.key.events).toEqual(['finished', 'stuck'])
    const plain = await auth.createKey({ name: 'phone', audience: 'client', caps: ['operate'], createdBy: 'local' })
    expect(plain.key).toMatchObject({ webhookUrl: null, events: null })
    expect(auth.webhookTargets('finished').map((t) => [t.keyId, t.url, t.secret])).toEqual(
      expect.arrayContaining([
        [made.key.id, 'https://bot.example/hook', made.webhookSecret],
        [own.key.id, 'https://other.example/x', 'my-own-secret']
      ])
    )
    expect(auth.webhookTargets('needs_you').map((t) => t.keyId)).toEqual([made.key.id])
    auth.revokeKey(made.key.id)
    expect(auth.webhookTargets('needs_you')).toEqual([])
  })
  it('refuses a bad URL, a short secret, events without a URL', async () => {
    await expectStatus(() => auth.createKey({ name: 'x', audience: 'mcp', caps: [], createdBy: 'local', webhookUrl: 'http://bot.example/hook' }), 400, 'must be https')
    await expectStatus(() => auth.createKey({ name: 'x', audience: 'mcp', caps: [], createdBy: 'local', webhookUrl: 'https://bot.example/hook', webhookSecret: 'short' }), 400, 'at least 8')
    await expectStatus(() => auth.createKey({ name: 'x', audience: 'mcp', caps: [], createdBy: 'local', events: ['finished'] }), 400, 'need a webhookUrl')
  })
})
