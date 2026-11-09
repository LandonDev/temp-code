import { describe, expect, it } from 'vitest'
import { ClientRequestSchema } from './contract'
import { ServiceIdSchema } from './contract-m3a'

/**
 * The account sync's requests name a service. Until 2026-11-08 the enum
 * held only claude-code, codex and cursor, so a Meta key, a Muse Code login
 * or an add-on grant crossing hosts was refused at parse (index.ts's
 * ClientRequestSchema.safeParse) while the unit tests, which call
 * AccountSync directly, never saw it.
 */
describe('ServiceIdSchema over the wire', () => {
  const services = ['meta', 'muse-code', 'addon'] as const
  const transfer = (service: string) => ({
    service,
    mode: 'access',
    profile: { name: 'p', accountId: 'a', createdAt: 1, static: true, owner: null },
    blob: '{}',
    expiresAt: null
  })
  const requests = (service: string) => [
    { id: '1', method: 'accounts.push', params: { from: 'env_mac', transfer: transfer(service) } },
    { id: '2', method: 'accounts.confirm', params: { from: 'env_mac', service, accountId: 'a', refreshFingerprint: 'f' } },
    { id: '3', method: 'accounts.released', params: { from: 'env_mac', service, accountId: 'a' } },
    { id: '4', method: 'accounts.removed', params: { from: 'env_mac', removed: [{ service, accountId: 'a', name: 'p', static: true, at: 1 }] } },
    { id: '5', method: 'accounts.pull', params: { from: 'env_mac', service, name: 'p' } }
  ]

  it.each(services)('every account-sync request naming %s parses', (service) => {
    for (const req of requests(service)) expect(ClientRequestSchema.safeParse(req).success, req.method).toBe(true)
  })

  it('names every aliax-core service and nothing else', () => {
    expect(ServiceIdSchema.options).toEqual(['claude-code', 'codex', 'cursor', 'meta', 'muse-code', 'addon'])
    expect(ServiceIdSchema.safeParse('gemini').success).toBe(false)
  })
})
