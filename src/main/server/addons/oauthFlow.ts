import { randomBytes } from 'node:crypto'
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  extractWWWAuthenticateParams,
  registerClient,
  startAuthorization
} from '@modelcontextprotocol/sdk/client/auth.js'
import { checkResourceAllowed } from '@modelcontextprotocol/sdk/shared/auth-utils.js'
import { AddonGrantBlobSchema, addonRedirectUri, type AddonGrantBlob } from '@shared/addonGrant'
import {
  GRANT_NOT_OAUTH,
  SIGNIN_DENIED,
  SIGNIN_ISSUER,
  SIGNIN_NO_ADDRESS,
  SIGNIN_NO_PKCE,
  SIGNIN_NO_REFRESH,
  SIGNIN_NO_REGISTRATION,
  SIGNIN_NO_SERVER,
  SIGNIN_NOT_NEEDED,
  SIGNIN_PORT_TAKEN,
  SIGNIN_SERVER,
  SIGNIN_UNREACHABLE,
  type SignInServerStep
} from '@shared/addonGrantWords'
import type { AddonSpec } from '@shared/contract-addons'
import { redact } from './downstream'
import { oauthCallback, type CallbackServer } from './oauthCallback'

/**
 * An add-on's MCP sign-in (plan-8YMm3ynnFZYs.md §6), in the main process of
 * a host with a browser (the Mac): discovery from the server's 401, the
 * resource's metadata, the authorization server's, dynamic client
 * registration with a fixed loopback redirect, PKCE S256, the browser, the
 * code on the callback, the exchange. It hands back the oauth section;
 * AddonGrants saves it under the profile lock onto the values stored at that
 * moment. The SDK's helpers do the wire work; every one gets a fetch that
 * passes a URL on as a string (the app's fetch rewrites strings) and records
 * the last HTTP status, because a failure is worded by its step and status
 * alone: the SDK puts response bodies in its messages, so none is shown.
 * No token, code, verifier or client secret reaches a log, a step, an error
 * or the view.
 */

export type AddonOAuth = NonNullable<AddonGrantBlob['oauth']>
const OAuthSectionSchema = AddonGrantBlobSchema.shape.oauth.unwrap()

export interface SignInInput {
  addon: { id: string; name: string; spec: AddonSpec }
  /** The grant stored here, if any: its client, client secret and redirect port are reused for this issuer. */
  prior: AddonGrantBlob | null
  /** Another host refreshes the stored grant: an answer without a refresh token could not land there (SIGNIN_NO_REFRESH). */
  refreshedElsewhere?: boolean
}

export type SignInStep = { step: 'discovering' } | { step: 'registering' } | { step: 'waiting'; port: number } | { step: 'exchanging' }

export interface SignInHooks {
  step(s: SignInStep): void
  /** A client was just registered: save it now (registered, not signed in: no tokens), before the browser opens. */
  registered(oauth: AddonOAuth): Promise<void>
}

export interface AddonSignIn {
  /** The signed-in oauth section; AddonGrants merges it onto the values stored at the save. Throws SignInError (its message the person's line) or an AbortError. */
  run(input: SignInInput, signal: AbortSignal, hooks: SignInHooks): Promise<AddonOAuth>
}

export interface OAuthFlowDeps {
  /** aliax's upstream().fetch, the fetch core refreshes with. */
  fetch: (input: string, init?: RequestInit) => Promise<Response>
  /** shell.openExternal; the seam's follower in the e2e. */
  open: (url: string) => Promise<void>
  now?: () => number
  /** TEMP_CODE_ADDON_TRACE=1: one line per step with host names and statuses, never a value. */
  trace?: (line: string) => void
  /** Test seam: the callback's timeout. */
  callbackTimeoutMs?: number
}

/** A failure in the person's words, safe to show and to log. */
export class SignInError extends Error {}

export const DISCOVERY_TIMEOUT_MS = 10_000
const OAUTH_ERROR_RE = /^[a-z_]{1,64}$/
// eslint-disable-next-line no-control-regex
const PRINTABLE_RE = /^[^\u0000-\u001f\u007f]*$/

const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
const sameIssuer = (a: string, b: string): boolean => a.replace(/\/+$/, '') === b.replace(/\/+$/, '')
const abortError = (): Error => Object.assign(new Error('aborted'), { name: 'AbortError' })

/** The words of a callback's error: an OAuth error code (else access_denied), and its description redacted, cut and kept only when printable. */
export function deniedLine(error: string, description: string | undefined, secrets: Iterable<string>): string {
  const code = OAUTH_ERROR_RE.test(error) ? error : 'access_denied'
  let text = description ? redact(description, secrets).trim() : ''
  if (text.length > 200) text = `${text.slice(0, 199)}…`
  return SIGNIN_DENIED(code, text && PRINTABLE_RE.test(text) ? text : undefined)
}

/**
 * The scope a sign-in asks for: the challenge's `scope`, else the resource's
 * `scopes_supported` joined, else none; `offline_access` added when the
 * authorization server lists it and grants refresh tokens, since some issue a
 * refresh token only for that scope and the box needs one. Mobbin: the
 * resource lists `openid`, Supabase offers offline_access → `openid offline_access`.
 */
export function scopeFor(
  challengeScope: string | undefined,
  resourceScopes: string[] | undefined,
  metadata: { scopes_supported?: string[]; grant_types_supported?: string[] }
): string | undefined {
  const scopes = (challengeScope ?? resourceScopes?.join(' ') ?? '').split(/\s+/).filter(Boolean)
  if (metadata.scopes_supported?.includes('offline_access') && metadata.grant_types_supported?.includes('refresh_token') && !scopes.includes('offline_access')) scopes.push('offline_access')
  return scopes.length ? scopes.join(' ') : undefined
}

export function oauthFlow(deps: OAuthFlowDeps): AddonSignIn {
  const now = deps.now ?? Date.now
  return {
    async run(input, signal, hooks) {
      const { addon, prior } = input
      const spec = addon.spec
      if (spec.auth !== 'oauth') throw new SignInError(GRANT_NOT_OAUTH(addon.name))
      if (spec.transport !== 'http') throw new SignInError(SIGNIN_NO_ADDRESS(addon.name))
      const urlHost = hostOf(spec.url)
      const trace = (line: string): void => deps.trace?.(`[addons] ${addon.name} sign-in: ${line}`)

      let lastStatus: number | null = null
      const fetchFn = async (url: string | URL, init?: RequestInit): Promise<Response> => {
        if (signal.aborted) throw abortError()
        const res = await deps.fetch(String(url), { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)]) })
        lastStatus = res.status
        trace(`${init?.method ?? 'GET'} ${hostOf(String(url))} → ${res.status}`)
        return res
      }
      /** A failed SDK call worded by its step and status, never its message. */
      const failed = (host: string, step: SignInServerStep): SignInError =>
        new SignInError(lastStatus !== null && (lastStatus < 200 || lastStatus >= 300) ? SIGNIN_SERVER(host, step, lastStatus) : SIGNIN_UNREACHABLE(host, step))
      const guard = async <T>(host: string, step: SignInServerStep, work: () => Promise<T>): Promise<T> => {
        lastStatus = null
        try {
          return await work()
        } catch (err) {
          if (signal.aborted) throw abortError()
          if (err instanceof SignInError) throw err
          throw failed(host, step)
        }
      }
      const checkAbort = (): void => {
        if (signal.aborted) throw abortError()
      }

      // 1. Discover: an unauthenticated initialize; the 401's challenge names the resource's metadata.
      hooks.step({ step: 'discovering' })
      const probe = await guard(urlHost, 'discovery', () =>
        fetchFn(spec.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'TempCode', version: '1' } } })
        })
      )
      await probe.body?.cancel().catch(() => {})
      if (probe.ok) throw new SignInError(SIGNIN_NOT_NEEDED(addon.name))
      if (probe.status !== 401) throw new SignInError(SIGNIN_SERVER(urlHost, 'discovery', probe.status))
      const challenge = extractWWWAuthenticateParams(probe)
      const resourceMeta = await guard(urlHost, 'discovery', () =>
        discoverOAuthProtectedResourceMetadata(spec.url, challenge.resourceMetadataUrl ? { resourceMetadataUrl: challenge.resourceMetadataUrl } : {}, fetchFn)
      )
      checkAbort()
      const issuer = resourceMeta.authorization_servers?.[0]
      if (!issuer) throw new SignInError(SIGNIN_NO_SERVER(urlHost))
      if (!checkResourceAllowed({ requestedResource: spec.url, configuredResource: resourceMeta.resource })) throw new SignInError(SIGNIN_ISSUER(urlHost))
      const issuerHost = hostOf(issuer)
      const metadata = await guard(issuerHost, 'discovery', async () => {
        const found = await discoverAuthorizationServerMetadata(issuer, { fetchFn })
        if (!found) throw new Error('no metadata')
        return found
      })
      checkAbort()
      if (!metadata.issuer || !sameIssuer(metadata.issuer, issuer)) throw new SignInError(SIGNIN_ISSUER(issuerHost))
      if (!metadata.code_challenge_methods_supported?.includes('S256')) throw new SignInError(SIGNIN_NO_PKCE(issuerHost))
      const resource = resourceMeta.resource

      // 2. Scope: the challenge's, else the resource's; offline_access when the server offers refresh tokens for it.
      const scope = scopeFor(challenge.scope, resourceMeta.scopes_supported, metadata)
      const state = randomBytes(32).toString('base64url')

      // 3. The client and its port: the prior client of this issuer on its fixed port, else a new port and a registration.
      const reuse = prior?.oauth && prior.oauth.issuer && sameIssuer(prior.oauth.issuer, issuer) ? prior.oauth : null
      let listener: CallbackServer
      let client: { client_id: string; client_secret?: string }
      const bind = async (port: number): Promise<CallbackServer> => {
        try {
          return await oauthCallback(port, state, { name: addon.name, timeoutMs: deps.callbackTimeoutMs })
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new SignInError(SIGNIN_PORT_TAKEN(port))
          throw new SignInError((err as Error).message.startsWith('refused:') ? (err as Error).message : SIGNIN_PORT_TAKEN(port))
        }
      }
      if (reuse) {
        listener = await bind(reuse.redirectPort)
        client = { client_id: reuse.clientId, ...(reuse.clientSecret ? { client_secret: reuse.clientSecret } : {}) }
        trace(`reusing its client on port ${listener.port}`)
      } else {
        hooks.step({ step: 'registering' })
        if (!metadata.registration_endpoint) throw new SignInError(SIGNIN_NO_REGISTRATION(issuerHost))
        listener = await bind(0)
        try {
          const registered = await guard(issuerHost, 'registration', () =>
            registerClient(issuer, {
              metadata,
              clientMetadata: {
                client_name: 'TempCode',
                redirect_uris: [addonRedirectUri(listener.port)],
                grant_types: ['authorization_code', 'refresh_token'],
                response_types: ['code'],
                token_endpoint_auth_method: 'none'
              },
              fetchFn
            })
          )
          client = { client_id: registered.client_id, ...(registered.client_secret ? { client_secret: registered.client_secret } : {}) }
          checkAbort()
          await hooks.registered(
            OAuthSectionSchema.parse({
              clientId: client.client_id,
              ...(client.client_secret ? { clientSecret: client.client_secret } : {}),
              redirectPort: listener.port,
              authorizationUrl: metadata.authorization_endpoint,
              tokenUrl: metadata.token_endpoint,
              ...(scope ? { scope } : {}),
              resource,
              issuer
            })
          )
          trace(`registered a client for port ${listener.port}`)
        } catch (err) {
          await listener.close()
          throw err
        }
      }

      try {
        checkAbort()
        // 4. Authorize: the browser, then the code on the callback.
        const redirectUri = addonRedirectUri(listener.port)
        const { authorizationUrl, codeVerifier } = await startAuthorization(issuer, {
          metadata,
          clientInformation: client,
          redirectUrl: redirectUri,
          scope,
          state,
          resource: new URL(resource)
        })
        hooks.step({ step: 'waiting', port: listener.port })
        await deps.open(authorizationUrl.toString())
        const answer = await listener.next(signal).catch((err: Error) => {
          if (err.name === 'AbortError') throw err
          throw new SignInError(err.message)
        })
        checkAbort()
        if ('error' in answer) {
          trace(`the callback said ${OAUTH_ERROR_RE.test(answer.error) ? answer.error : 'an error'}`)
          throw new SignInError(deniedLine(answer.error, answer.description, [codeVerifier, state, client.client_secret ?? '']))
        }

        // 5. Exchange.
        hooks.step({ step: 'exchanging' })
        const tokens = await guard(issuerHost, 'exchange', () =>
          exchangeAuthorization(issuer, { metadata, clientInformation: client, authorizationCode: answer.code, codeVerifier, redirectUri, resource: new URL(resource), fetchFn })
        )
        checkAbort()
        if (!tokens.refresh_token && input.refreshedElsewhere) throw new SignInError(SIGNIN_NO_REFRESH(issuerHost))
        trace(`signed in${tokens.refresh_token ? ' with a refresh token' : ', no refresh token'}`)
        return OAuthSectionSchema.parse({
          clientId: client.client_id,
          ...(client.client_secret ? { clientSecret: client.client_secret } : {}),
          redirectPort: listener.port,
          authorizationUrl: metadata.authorization_endpoint,
          tokenUrl: metadata.token_endpoint,
          ...((tokens.scope ?? scope) ? { scope: tokens.scope ?? scope } : {}),
          resource,
          issuer,
          accessToken: tokens.access_token,
          ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
          ...(typeof tokens.expires_in === 'number' ? { expiresAt: now() + tokens.expires_in * 1000 } : {})
        })
      } finally {
        await listener.close()
      }
    }
  }
}
