import type { ProfileView, ServiceId, UsageReport } from 'aliax-core/shared/types'

/** The harnesses that have an Aliax service behind them. */
export type AccountProvider = 'claude' | 'codex' | 'cursor'

export const ACCOUNT_PROVIDERS: AccountProvider[] = ['claude', 'codex', 'cursor']

/** Harness id ↔ Aliax service id. */
export const SERVICE_OF: Record<AccountProvider, ServiceId> = {
  claude: 'claude-code',
  codex: 'codex',
  cursor: 'cursor'
}
export const PROVIDER_OF: Record<ServiceId, AccountProvider> = {
  'claude-code': 'claude',
  codex: 'codex',
  cursor: 'cursor'
}

export const isAccountProvider = (id: string): id is AccountProvider => id in SERVICE_OF

export interface ProviderAccounts {
  /** The profile the gateway routes to (Aliax's proxyAccounts), null when unset. */
  pinned: string | null
  profiles: ProfileView[]
  reports: UsageReport[]
  /** Who holds the gateway right now. */
  owner: 'aliax' | 'temp-code' | null
  /** Why the numbers are thin, when they are ("vault locked", …). */
  note?: string
}

export interface AccountsSnapshot {
  updatedAt: number
  providers: Record<AccountProvider, ProviderAccounts>
}

export const emptyAccounts = (): AccountsSnapshot => ({
  updatedAt: 0,
  providers: {
    claude: { pinned: null, profiles: [], reports: [], owner: null },
    codex: { pinned: null, profiles: [], reports: [], owner: null },
    cursor: { pinned: null, profiles: [], reports: [], owner: null }
  }
})
