import type { ServiceId, UsageWindow } from 'aliax-core'

/** Only real provider observations reach this hook; cached poll answers do not. */
export const usageSamples: { current: ((service: ServiceId, account: string, window: UsageWindow) => void) | null } = { current: null }
