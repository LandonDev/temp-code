import { credentialFor } from 'aliax-core'
import type { AccountProvider } from '@shared/accounts'
import type { PreconnectOutcome, Upstream } from './upstream'

/**
 * Pre-connect: the upstream socket a thread's next request will ride is
 * opened (or its free one refreshed) before the request exists, so the
 * first token of a turn does not wait on a TLS handshake. Asked when a
 * turn starts and when the composer of an idle thread gains focus; the
 * pools themselves hold it to one per account per minute, so a focus that
 * flickers costs nothing.
 */
export const PROVIDER_ORIGIN: Record<'claude' | 'codex', string> = {
  claude: 'https://api.anthropic.com',
  codex: 'https://chatgpt.com'
}

export interface PreconnectDeps {
  upstream: Upstream
  /** The credential a request under `account` would carry (the pinned one for null). aliax-core's by default. */
  credential?: (service: string, account: string | null) => Promise<{ authorization: string } | null>
}

export type AccountPreconnect = PreconnectOutcome | 'no-provider' | 'no-credential'

const TRACE = process.env.TEMP_CODE_GATEWAY_TRACE === '1'

/** Never throws: a pre-connect is a hint, and the turn goes out regardless. */
export async function preconnectAccount(
  provider: AccountProvider | string,
  account: string | null,
  deps: PreconnectDeps
): Promise<AccountPreconnect> {
  if (provider !== 'claude' && provider !== 'codex') return 'no-provider'
  let outcome: AccountPreconnect
  try {
    const credential = await (deps.credential ?? credentialFor)(provider, account)
    if (!credential) outcome = 'no-credential'
    else outcome = await deps.upstream.preconnect(PROVIDER_ORIGIN[provider], credential.authorization)
  } catch {
    outcome = 'failed'
  }
  if (TRACE && outcome !== 'throttled') console.log(`[gateway] preconnect ${provider} ${account ?? '(pinned)'}: ${outcome}`)
  return outcome
}
