import { generateKeyPairSync, verify } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Http2Server, type IncomingHttpHeaders } from 'node:http2'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ApnsSender, apnsFromEnv, JWT_LIFETIME_MS } from './apns'
import { activityPayload, notificationPayload } from './apnsPayload'

/** A fake APNs over h2c: records every request, answers what the test queued. */
interface Seen {
  headers: IncomingHttpHeaders
  body: string
}
let server: Http2Server
let origin: string
let seen: Seen[]
let answers: { status: number; reason?: string }[]
let dir: string
let publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']
let keyPath: string

beforeEach(async () => {
  seen = []
  answers = []
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString('utf8')))
    req.on('end', () => {
      seen.push({ headers: req.headers, body })
      const answer = answers.shift() ?? { status: 200 }
      res.statusCode = answer.status
      res.end(answer.reason ? JSON.stringify({ reason: answer.reason }) : '')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  // A throwaway P-256 pair: the private half as the .p8 a host holds, the public half to check signatures.
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  publicKey = pair.publicKey
  dir = mkdtempSync(join(tmpdir(), 'tc-apns-'))
  keyPath = join(dir, 'AuthKey_TEST.p8')
  writeFileSync(keyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }))
})
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(dir, { recursive: true, force: true })
})

const b64 = (text: string): Buffer => Buffer.from(text, 'base64url')
const TOKEN = 'ab'.repeat(32)
const alert = { token: TOKEN, topic: 'dev.landon.tempcode.ios', pushType: 'alert' as const, environment: 'sandbox' as const, payload: { aps: { alert: { title: 't' } } }, expiration: 1_760_003_600, collapseId: 'thread-1:needs_you', id: 'delivery-1' }

describe('ApnsSender', () => {
  it('mints one ES256 provider token per lifetime, signed with the key, naming the team and the key id', () => {
    let now = 1_760_000_000_000
    const sender = new ApnsSender({ keyPath, keyId: 'KEY1234567', teamId: 'TEAM123456', gateway: origin, now: () => now, log: () => {} })
    const jwt = sender.providerToken()
    const [h, c, s] = jwt.split('.')
    expect(JSON.parse(b64(h).toString())).toEqual({ alg: 'ES256', kid: 'KEY1234567' })
    expect(JSON.parse(b64(c).toString())).toEqual({ iss: 'TEAM123456', iat: 1_760_000_000 })
    expect(verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, b64(s))).toBe(true)
    now += JWT_LIFETIME_MS - 1
    expect(sender.providerToken()).toBe(jwt)
    now += 1
    expect(sender.providerToken()).not.toBe(jwt)
    sender.close()
  })
  it('posts one request per push with the token path, the headers and the exact body, reusing the session', async () => {
    const sender = new ApnsSender({ keyPath, keyId: 'KEY1234567', teamId: 'TEAM123456', gateway: origin, log: () => {} })
    expect(await sender.send(alert)).toEqual({ ok: true })
    expect(await sender.send({ ...alert, pushType: 'liveactivity', topic: 'dev.landon.tempcode.ios.push-type.liveactivity', priority: 5, collapseId: 'thread-1', id: undefined })).toEqual({ ok: true })
    expect(seen).toHaveLength(2)
    const first = seen[0].headers
    expect(first[':path']).toBe(`/3/device/${TOKEN}`)
    expect(first[':method']).toBe('POST')
    expect(String(first.authorization)).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/)
    expect(first['apns-topic']).toBe('dev.landon.tempcode.ios')
    expect(first['apns-push-type']).toBe('alert')
    expect(first['apns-priority']).toBe('10')
    expect(first['apns-expiration']).toBe('1760003600')
    expect(first['apns-collapse-id']).toBe('thread-1:needs_you')
    expect(first['apns-id']).toBe('delivery-1')
    expect(JSON.parse(seen[0].body)).toEqual(alert.payload)
    const second = seen[1].headers
    expect(second['apns-push-type']).toBe('liveactivity')
    expect(second['apns-priority']).toBe('5')
    expect(second['apns-topic']).toBe('dev.landon.tempcode.ios.push-type.liveactivity')
    expect(second).not.toHaveProperty('apns-id')
    sender.close()
  })
  it('calls a dead token gone, counts other refusals, retries a 5xx, and re-mints on a refused provider token', async () => {
    const sender = new ApnsSender({ keyPath, keyId: 'KEY1234567', teamId: 'TEAM123456', gateway: origin, log: () => {} })
    answers.push({ status: 410, reason: 'Unregistered' })
    expect(await sender.send(alert)).toEqual({ ok: false, error: 'APNs 410 Unregistered', gone: true })
    answers.push({ status: 400, reason: 'BadDeviceToken' })
    expect(await sender.send(alert)).toEqual({ ok: false, error: 'APNs 400 BadDeviceToken', gone: true })
    answers.push({ status: 400, reason: 'BadMessageId' })
    expect(await sender.send(alert)).toEqual({ ok: false, error: 'APNs 400 BadMessageId', gone: false })
    answers.push({ status: 500, reason: 'InternalServerError' }, { status: 503 }, { status: 200 })
    seen = []
    expect(await sender.send(alert)).toEqual({ ok: true })
    expect(seen).toHaveLength(3)
    answers.push({ status: 500 }, { status: 500 }, { status: 500 })
    expect(await sender.send(alert)).toEqual({ ok: false, error: 'APNs 500', gone: false })
    answers.push({ status: 403, reason: 'ExpiredProviderToken' }, { status: 200 })
    seen = []
    expect(await sender.send(alert)).toEqual({ ok: true })
    expect(seen).toHaveLength(2)
    expect(seen[0].headers.authorization).not.toBe(seen[1].headers.authorization)
    answers.push({ status: 403, reason: 'InvalidProviderToken' }, { status: 403, reason: 'InvalidProviderToken' })
    expect(await sender.send(alert)).toEqual({ ok: false, error: 'APNs 403 InvalidProviderToken', gone: false })
    sender.close()
  })
  it('answers a network error for a gateway that is not there', async () => {
    const sender = new ApnsSender({ keyPath, keyId: 'KEY1234567', teamId: 'TEAM123456', gateway: 'http://127.0.0.1:1', log: () => {} })
    expect(await sender.send(alert)).toEqual({ ok: false, error: 'APNs network error', gone: false })
    sender.close()
  })
  it('comes from the three variables together, and never from a key it cannot read', () => {
    const lines: string[] = []
    const log = (l: string) => lines.push(l)
    expect(apnsFromEnv({}, log)).toBeNull()
    expect(apnsFromEnv({ TEMP_CODE_APNS_KEY_ID: 'KEY1234567' }, log)).toBeNull()
    expect(apnsFromEnv({ TEMP_CODE_APNS_KEY_PATH: join(dir, 'missing.p8'), TEMP_CODE_APNS_KEY_ID: 'KEY1234567', TEMP_CODE_APNS_TEAM_ID: 'TEAM123456' }, log)).toBeNull()
    expect(apnsFromEnv({ TEMP_CODE_APNS_KEY_PATH: keyPath, TEMP_CODE_APNS_KEY_ID: 'short', TEMP_CODE_APNS_TEAM_ID: 'TEAM123456' }, log)).toBeNull()
    const sender = apnsFromEnv({ TEMP_CODE_APNS_KEY_PATH: keyPath, TEMP_CODE_APNS_KEY_ID: 'KEY1234567', TEMP_CODE_APNS_TEAM_ID: 'TEAM123456', TEMP_CODE_APNS_URL: origin }, log)
    expect(sender).not.toBeNull()
    expect(sender!.gateway('production')).toBe(origin)
    expect(new ApnsSender({ keyPath, keyId: 'KEY1234567', teamId: 'TEAM123456' }).gateway('production')).toBe('https://api.push.apple.com')
    sender!.close()
    expect(lines).toHaveLength(3)
    expect(lines.join('\n')).not.toContain('PRIVATE')
  })
})

describe('payloads', () => {
  it('match the hub: the alert with tc, the activity with content-state and a dismissal date on end', () => {
    expect(notificationPayload({ event: 'needs_you', hostId: 'box', environmentId: 'env_box', threadId: 't1', seq: 42, title: 'Ship it', body: 'Permission: Bash', ts: 2000 })).toEqual({
      aps: { alert: { title: 'Ship it', body: 'Permission: Bash' }, sound: 'default', 'thread-id': 't1', 'summary-arg': 'Ship it', 'interruption-level': 'time-sensitive', 'relevance-score': 1, category: 'tc.thread' },
      tc: { event: 'needs_you', hostId: 'box', environmentId: 'env_box', threadId: 't1', seq: 42, ts: 2000 }
    })
    const finished = notificationPayload({ event: 'finished', hostId: 'box', title: 'Done', body: 'Finished its turn', ts: 3 }) as { aps: Record<string, unknown>; tc: Record<string, unknown> }
    expect(finished.aps['interruption-level']).toBe('active')
    expect(finished.aps['thread-id']).toBe('box')
    expect(finished.tc).not.toHaveProperty('seq')
    const update = activityPayload({ threadId: 't1', event: 'update', state: { phase: 'working', since: 1000, ts: 5000 }, ts: 5000 }, 5000) as { aps: Record<string, unknown> }
    expect(update.aps).toEqual({ timestamp: 5, event: 'update', 'content-state': { phase: 'working', since: 1000, ts: 5000 }, 'relevance-score': 50 })
    const end = activityPayload({ threadId: 't1', event: 'end', state: { phase: 'waiting', since: 1000, ts: 7000, seq: 42 }, ts: 7000 }, 7000) as { aps: Record<string, unknown> }
    expect(end.aps).toMatchObject({ event: 'end', 'dismissal-date': 7 + 120, 'relevance-score': 100 })
  })
})
