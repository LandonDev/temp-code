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

/** The providers whose traffic goes through the gateway, so a thread can name its account. */
export type RoutedProvider = 'claude' | 'codex'
export const ROUTED_PROVIDERS: RoutedProvider[] = ['claude', 'codex']
export const isRoutedProvider = (id: string): id is RoutedProvider => id === 'claude' || id === 'codex'

/**
 * One explicit account per provider, on a project or a workspace: threads of
 * both providers hang off the same project. Absent means inherit (workspace,
 * then auto).
 */
export type AccountPins = Partial<Record<AccountProvider, string>>

/**
 * The account a thread's child process spends from, baked into its gateway
 * URL: `pin` says it is an explicit pin (thread, project or workspace) the
 * gateway returns to once it has room again, not an automatic pick.
 */
export interface AccountRoute {
  account: string
  pin: boolean
}

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
