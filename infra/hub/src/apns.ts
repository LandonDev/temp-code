import type { Env, PushEnvironment } from './types'

/**
 * APNs with token-based auth. The .p8 key, its id and the team id are Worker
 * secrets (APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID); the provider token is an
 * ES256 JWT Apple wants refreshed no sooner than every 20 minutes and no
 * later than every hour, so one is kept per isolate for 50 minutes. Every
 * push is one HTTP/2 POST to Apple's gateway for the token's environment
 * (APNS_URL overrides both, for a test receiver). Nothing here touches KV
 * or the directory; the caller decides what a `gone` answer means.
 */

const GATEWAYS: Record<PushEnvironment, string> = {
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
  /** The apns-id header; the delivery id the caller logs. */
  id?: string
}

export type ApnsResult =
  | { ok: true }
  | {
      ok: false
      /** A short code without token text: "APNs 400 BadDeviceToken", "APNs timeout", "APNs not configured". */
      error: string
      /** Apple says the token is dead for this topic: drop the registration. */
      gone: boolean
    }

const encoder = new TextEncoder()
const base64url = (bytes: ArrayBuffer | Uint8Array | string): string => {
  const raw = typeof bytes === 'string' ? encoder.encode(bytes) : new Uint8Array(bytes)
  let text = ''
  for (const b of raw) text += String.fromCharCode(b)
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The PKCS#8 PEM Apple hands out, as DER. */
function pem2der(pem: string): ArrayBuffer {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  const bin = atob(body)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}

interface Cached {
  jwt: string
  issuedAt: number
}
const cache = new Map<string, Cached>()

/** Forgets every cached provider token (tests, and a 403 from Apple). */
export function apnsReset(): void {
  cache.clear()
}

export function apnsConfigured(env: Env): boolean {
  return !!(env.APNS_KEY && env.APNS_KEY_ID && env.APNS_TEAM_ID)
}

/** The provider token for this isolate, minted at most once per lifetime. */
export async function providerToken(env: Env, now = Date.now()): Promise<string> {
  if (!apnsConfigured(env)) throw new Error('APNs not configured')
  const keyId = env.APNS_KEY_ID!
  const teamId = env.APNS_TEAM_ID!
  const cacheKey = `${teamId}:${keyId}`
  const hit = cache.get(cacheKey)
  if (hit && now - hit.issuedAt < JWT_LIFETIME_MS) return hit.jwt
  const key = await crypto.subtle.importKey('pkcs8', pem2der(env.APNS_KEY!), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId }))
  const claims = base64url(JSON.stringify({ iss: teamId, iat: Math.floor(now / 1000) }))
  const signingInput = `${header}.${claims}`
  // WebCrypto's ECDSA signature is r‖s already: the JOSE form ES256 wants.
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(signingInput))
  const jwt = `${signingInput}.${base64url(signature)}`
  cache.set(cacheKey, { jwt, issuedAt: now })
  return jwt
}

export function gateway(env: Env, environment: PushEnvironment): string {
  return (env.APNS_URL || GATEWAYS[environment]).replace(/\/$/, '')
}

/** One push. A 5xx, a timeout or a network error is tried once more; a rejected provider token is re-minted once. */
export async function apnsSend(env: Env, request: ApnsRequest): Promise<ApnsResult> {
  if (!apnsConfigured(env)) return { ok: false, error: 'APNs not configured', gone: false }
  const url = `${gateway(env, request.environment)}/3/device/${request.token}`
  const body = JSON.stringify(request.payload)
  let error = 'APNs failed'
  let reminted = false
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 200))
    let jwt: string
    try {
      jwt = await providerToken(env)
    } catch {
      return { ok: false, error: 'APNs key unreadable', gone: false }
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), APNS_TIMEOUT_MS)
    try {
      const response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          authorization: `bearer ${jwt}`,
          'apns-topic': request.topic,
          'apns-push-type': request.pushType,
          'apns-priority': String(request.priority ?? 10),
          'apns-expiration': String(request.expiration),
          ...(request.collapseId ? { 'apns-collapse-id': request.collapseId.slice(0, 64) } : {}),
          ...(request.id ? { 'apns-id': request.id } : {}),
          'content-type': 'application/json'
        },
        body
      })
      if (response.ok) {
        await response.body?.cancel()
        return { ok: true }
      }
      let reason = ''
      try {
        reason = String(((await response.json()) as { reason?: string }).reason ?? '')
      } catch {
        // No reason body: the status is the message.
      }
      error = `APNs ${response.status}${reason ? ' ' + reason.replace(/[^A-Za-z0-9]/g, '').slice(0, 40) : ''}`
      if (response.status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered' || reason === 'DeviceTokenNotForTopic')
        return { ok: false, error, gone: true }
      if (response.status === 403 && !reminted) {
        // ExpiredProviderToken / InvalidProviderToken: mint a fresh one and go again.
        reminted = true
        apnsReset()
        continue
      }
      if (response.status < 500 || response.status === 429) return { ok: false, error, gone: false }
    } catch {
      error = controller.signal.aborted ? 'APNs timeout' : 'APNs network error'
    } finally {
      clearTimeout(timeout)
    }
  }
  return { ok: false, error, gone: false }
}
