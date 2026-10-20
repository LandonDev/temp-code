import { createPrivateKey, sign, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { connect, constants, type ClientHttp2Session } from 'node:http2'
import type { PushEnvironment } from '@shared/contract-remote'

/**
 * APNs from the host, over HTTP/2 with token auth (thread L6). The hub's
 * delivery (infra/hub/src/apns.ts) has the same shape, but Cloudflare's
 * fetch speaks HTTP/1.1 to origins and Apple refuses it, so a host that
 * holds the key (TEMP_CODE_APNS_KEY_PATH, _KEY_ID, _TEAM_ID) posts itself:
 * one ES256 provider token kept for 50 minutes, one http2 session per
 * gateway reused across pushes, one request per device. The key file lives
 * outside the repo (on the box: /etc/temp-code/apns, root-owned, readable by
 * the service); nothing here logs the token, the key or a payload.
 */

export const GATEWAYS: Record<PushEnvironment, string> = {
  sandbox: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com'
}
export const JWT_LIFETIME_MS = 50 * 60_000
export const APNS_TIMEOUT_MS = 10_000

export interface ApnsRequest {
  token: string
  topic: string
  pushType: 'alert' | 'liveactivity'
  environment: PushEnvironment
  payload: unknown
  /** Seconds since the epoch; 0 means deliver now or never. */
  expiration: number
  collapseId?: string
  priority?: 5 | 10
  id?: string
}

export type ApnsResult =
  | { ok: true }
  | {
      ok: false
      /** A short code without token text: "APNs 400 BadDeviceToken", "APNs timeout", "APNs network error". */
      error: string
      /** Apple says the token is dead for this topic: drop the registration. */
      gone: boolean
    }

export interface ApnsOptions {
  /** The .p8 file Apple hands out. */
  keyPath: string
  keyId: string
  teamId: string
  /** One gateway for both environments (a test server; h2c when http). */
  gateway?: string
  now?: () => number
  log?: (line: string) => void
}

const GONE = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic'])
const b64url = (value: Buffer | string): string => Buffer.from(value).toString('base64url')

export class ApnsSender {
  private readonly key: KeyObject
  private readonly now: () => number
  private readonly log: (line: string) => void
  private jwt: { value: string; issuedAt: number } | null = null
  private readonly sessions = new Map<string, ClientHttp2Session>()
  private closed = false

  constructor(private readonly options: ApnsOptions) {
    this.key = createPrivateKey(readFileSync(options.keyPath, 'utf8'))
    this.now = options.now ?? Date.now
    this.log = options.log ?? ((line) => console.error(`[apns] ${line}`))
  }

  /** The provider token: `{ alg: ES256, kid }` over `{ iss: team, iat }`, minted at most once per lifetime. */
  providerToken(now = this.now()): string {
    if (this.jwt && now - this.jwt.issuedAt < JWT_LIFETIME_MS) return this.jwt.value
    const input = `${b64url(JSON.stringify({ alg: 'ES256', kid: this.options.keyId }))}.${b64url(JSON.stringify({ iss: this.options.teamId, iat: Math.floor(now / 1000) }))}`
    // ES256 wants the raw r‖s signature, not DER.
    const signature = sign('sha256', Buffer.from(input), { key: this.key, dsaEncoding: 'ieee-p1363' })
    this.jwt = { value: `${input}.${b64url(signature)}`, issuedAt: now }
    return this.jwt.value
  }

  gateway(environment: PushEnvironment): string {
    return (this.options.gateway || GATEWAYS[environment]).replace(/\/$/, '')
  }

  private session(origin: string): ClientHttp2Session {
    const live = this.sessions.get(origin)
    if (live && !live.closed && !live.destroyed) return live
    const session = connect(origin)
    session.on('error', (err: Error) => {
      // The gateway's host alone: no token, no payload.
      this.log(`session to ${new URL(origin).host} failed: ${err.message}`)
      if (this.sessions.get(origin) === session) this.sessions.delete(origin)
    })
    session.on('close', () => {
      if (this.sessions.get(origin) === session) this.sessions.delete(origin)
    })
    this.sessions.set(origin, session)
    return session
  }

  /** One push. A 5xx, a timeout or a network error is tried once more; a refused provider token is re-minted once. */
  async send(request: ApnsRequest): Promise<ApnsResult> {
    if (this.closed) return { ok: false, error: 'APNs sender closed', gone: false }
    const origin = this.gateway(request.environment)
    const body = JSON.stringify(request.payload)
    let error = 'APNs failed'
    let reminted = false
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 200))
      const answer = await this.post(origin, request, body)
      if (answer.kind === 'network') {
        error = answer.error
        continue
      }
      if (answer.status >= 200 && answer.status < 300) return { ok: true }
      const reason = answer.reason.replace(/[^A-Za-z0-9]/g, '').slice(0, 40)
      error = `APNs ${answer.status}${reason ? ' ' + reason : ''}`
      if (answer.status === 410 || GONE.has(reason)) return { ok: false, error, gone: true }
      if (answer.status === 403 && !reminted) {
        reminted = true
        this.jwt = null
        continue
      }
      if (answer.status < 500 || answer.status === 429) return { ok: false, error, gone: false }
    }
    return { ok: false, error, gone: false }
  }

  private post(origin: string, request: ApnsRequest, body: string): Promise<{ kind: 'network'; error: string } | { kind: 'answer'; status: number; reason: string }> {
    return new Promise((resolve) => {
      let settled = false
      const done = (value: { kind: 'network'; error: string } | { kind: 'answer'; status: number; reason: string }): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      let stream: ReturnType<ClientHttp2Session['request']>
      try {
        stream = this.session(origin).request({
          [constants.HTTP2_HEADER_METHOD]: 'POST',
          [constants.HTTP2_HEADER_PATH]: `/3/device/${request.token}`,
          authorization: `bearer ${this.providerToken()}`,
          'apns-topic': request.topic,
          'apns-push-type': request.pushType,
          'apns-priority': String(request.priority ?? 10),
          'apns-expiration': String(request.expiration),
          ...(request.collapseId ? { 'apns-collapse-id': request.collapseId.slice(0, 64) } : {}),
          ...(request.id ? { 'apns-id': request.id } : {}),
          'content-type': 'application/json'
        })
      } catch {
        done({ kind: 'network', error: 'APNs network error' })
        return
      }
      const timer = setTimeout(() => {
        stream.close(constants.NGHTTP2_CANCEL)
        done({ kind: 'network', error: 'APNs timeout' })
      }, APNS_TIMEOUT_MS)
      timer.unref?.()
      let status = 0
      let text = ''
      stream.on('response', (headers) => {
        status = Number(headers[constants.HTTP2_HEADER_STATUS] ?? 0)
      })
      stream.on('data', (chunk: Buffer) => {
        if (text.length < 4096) text += chunk.toString('utf8')
      })
      stream.on('end', () => {
        let reason = ''
        try {
          reason = String((JSON.parse(text) as { reason?: string }).reason ?? '')
        } catch {
          // No reason body: the status is the message.
        }
        done({ kind: 'answer', status, reason })
      })
      stream.on('error', () => done({ kind: 'network', error: 'APNs network error' }))
      stream.end(body)
    })
  }

  close(): void {
    this.closed = true
    for (const session of this.sessions.values()) session.close()
    this.sessions.clear()
  }
}

/** The sender for this host, when the three variables name the key; a key that cannot be read logs once and leaves push to the hub. */
export function apnsFromEnv(env: NodeJS.ProcessEnv = process.env, log: (line: string) => void = (line) => console.error(`[apns] ${line}`)): ApnsSender | null {
  const keyPath = env.TEMP_CODE_APNS_KEY_PATH
  const keyId = env.TEMP_CODE_APNS_KEY_ID
  const teamId = env.TEMP_CODE_APNS_TEAM_ID
  if (!keyPath && !keyId && !teamId) return null
  if (!keyPath || !keyId || !teamId) {
    log('disabled: set TEMP_CODE_APNS_KEY_PATH, TEMP_CODE_APNS_KEY_ID and TEMP_CODE_APNS_TEAM_ID together')
    return null
  }
  if (!/^[A-Z0-9]{10}$/.test(keyId) || !/^[A-Z0-9]{10}$/.test(teamId)) {
    log('disabled: the key id and team id are ten characters each')
    return null
  }
  try {
    return new ApnsSender({ keyPath, keyId, teamId, ...(env.TEMP_CODE_APNS_URL ? { gateway: env.TEMP_CODE_APNS_URL } : {}), log })
  } catch (err) {
    log(`disabled: the key could not be read (${err instanceof Error ? err.message : String(err)})`)
    return null
  }
}
