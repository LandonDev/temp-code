import { describe, expect, it } from 'vitest'
import { CATALOG, PROBED_PROVIDERS, resolveModel, type ProviderId } from './catalog'
import { ThreadDefaultsSchema } from './defaults'
import { RoutingRuleSchema } from './rules'
import { ReviewSettingsSchema } from './review'
import { ProviderIdSchema } from './wireSchemas'
import { CreateSessionParams } from './contract'
import { ThreadStartArgsSchema } from './contract-crosshost'

/**
 * Every provider id the catalog knows parses through every hand-copied zod
 * enum: a provider added to one copy and missed in another refuses a
 * thread somewhere else (the picker, a cross-host start, a review setting).
 */
const PROVIDERS = Object.keys(CATALOG) as ProviderId[]

describe('provider enums', () => {
  it('every catalog provider parses through each copied enum', () => {
    for (const p of PROVIDERS) {
      expect(ProviderIdSchema.parse(p)).toBe(p)
      expect(RoutingRuleSchema.parse({ id: 'r', task: 't', provider: p }).provider).toBe(p)
      expect(ReviewSettingsSchema.parse({ provider: p }).provider).toBe(p)
      expect(ThreadDefaultsSchema.parse({ provider: p }).provider).toBe(p)
      expect(CreateSessionParams.parse({ provider: p }).provider).toBe(p)
      expect(ThreadStartArgsSchema.parse({ threadType: 'chat', provider: p, firstMessage: 'm', cwd: '/w' }).provider).toBe(p)
    }
  })

  it('muse is probed and keeps its own ids under its own harness', () => {
    expect(PROBED_PROVIDERS).toContain('muse')
    expect(CATALOG.muse.label).toBe('Muse Code')
    expect(resolveModel('muse', 'muse-wonder-1.0')).toEqual({ provider: 'muse', model: 'muse-wonder-1.0' })
    expect(resolveModel('muse', '')).toEqual({ provider: 'muse', model: CATALOG.muse.defaultModel })
  })
})
