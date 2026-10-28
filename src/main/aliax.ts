import { app, net, session } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { configure, isLive, readMarker, type Role } from 'aliax-core'
import { notifyAccountsChanged } from './aliaxPages'
import { statsHost } from './aliax/stats/statsService'
import { gateway } from './server/gateway'
import { accountSyncHooks } from './server/remote/accountSync'
import { fakeProviderRewrite, Upstream } from './server/upstream'

/** An isolated instance (TEMP_CODE_USER_DATA) may keep its own vault, so a test never reads the real one. */
const ISOLATED_VAULT = process.env.TEMP_CODE_USER_DATA ? process.env.TEMP_CODE_ALIAX_DATA_DIR : undefined

/** Aliax's own userData: the vault, settings and usage cache both apps share. */
export const ALIAX_DATA_DIR = ISOLATED_VAULT || join(app.getPath('appData'), 'aliax')

export const aliaxInstalled = (): boolean => existsSync(join(ALIAX_DATA_DIR, 'profiles.json'))

/**
 * Owner only while this very process holds the gateway marker. An isolated
 * instance may say TEMP_CODE_GATEWAY_ROLE=owner to refresh its own vault's
 * tokens without claiming the marker (the e2e's fake provider needs that).
 */
export function gatewayRole(): Role {
  if (process.env.TEMP_CODE_USER_DATA && process.env.TEMP_CODE_GATEWAY_ROLE === 'owner') return 'owner'
  const m = readMarker()
  return isLive(m) && m.owner === 'temp-code' && m.pid === process.pid ? 'owner' : 'standby'
}

/**
 * TEMP_CODE_FAKE_PROVIDERS=<origin>, isolated instances only: every call the
 * core makes to a provider goes to that origin instead, so an e2e can rotate
 * tokens and answer usage without a real account.
 */
export const FAKE_PROVIDERS = (process.env.TEMP_CODE_USER_DATA ? process.env.TEMP_CODE_FAKE_PROVIDERS : undefined) || null

/** A provider URL as this instance reaches it: itself, or the fake provider's when one stands in. */
export const providerUrl = fakeProviderRewrite(FAKE_PROVIDERS)

/**
 * The connections every provider call rides (src/main/server/upstream.ts):
 * api.anthropic.com on keep-alive pools per account, everything else on
 * Chromium's stack through `net.fetch` (Cloudflare refuses Node's TLS on
 * chatgpt.com) with Chromium's own pool and `ses.preconnect`. Made once,
 * before aliax-core is configured, so the gateway's forward and the
 * pre-connects share the sockets.
 */
let upstreamInstance: Upstream | null = null
export function upstream(): Upstream {
  if (!upstreamInstance) {
    upstreamInstance = new Upstream({
      chromiumFetch: (input, init) => net.fetch(input, init),
      chromiumPreconnect: (origin) => session.defaultSession.preconnect({ url: origin, numSockets: 1 }),
      rewrite: providerUrl
    })
  }
  return upstreamInstance
}

/**
 * Point aliax-core at Aliax's data. On macOS secrets open with the same
 * Keychain item Electron's safeStorage made for Aliax, so the first read
 * prompts once for "aliax Safe Storage"; a denied prompt leaves the vault
 * locked, never broken. A Linux host has no Keychain and no Aliax app, and
 * an isolated vault has no Keychain item: both seal with their own key file
 * (<dataDir>/vault.key, mode 0600), the same bytes under a different lock.
 * `environmentId` is what every profile's owner is compared to (sync.ts).
 */
export function configureAliax(environmentId?: string): void {
  configure({
    dataDir: ALIAX_DATA_DIR,
    fetch: (input, init) => upstream().fetch(input, init),
    secrets:
      process.platform === 'darwin' && !ISOLATED_VAULT
        ? { mode: 'chromiumKey', keychainItem: 'aliax Safe Storage' }
        : { mode: 'fileKey' },
    appName: 'temp-code',
    environmentId,
    // The embedded Stats page reads what Aliax's would: every fresh usage
    // sample and app event lands in our stats store, and a switch or
    // failover redraws the Accounts page in every window. Vault writes and
    // a consumer's ask go to the account sync once the server made it.
    hooks: {
      onUsageSample: (s) =>
        statsHost().sample(s.service, s.account, s.label, s.usedPercent, s.resetsAt, s.periodMs),
      onAppEvent: (kind, service, account, detail) => statsHost().appEvent(kind, service, account, detail),
      onAccountsChanged: notifyAccountsChanged,
      onSecretSaved: (service, name, origin) => {
        // The gateway's own process asks again for that service's credentials.
        gateway()?.credentialsChanged(service)
        accountSyncHooks.current?.onSecretSaved(service, name, origin)
      },
      askOwner: (service, name, owner) => accountSyncHooks.current?.askOwner(service, name, owner) ?? Promise.resolve(null)
    },
    role: gatewayRole
  })
}
