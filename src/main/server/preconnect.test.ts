import { describe, expect, it } from 'vitest'
import { PROVIDER_ORIGIN, preconnectAccount } from './preconnect'
import type { Upstream } from './upstream'

const fakeUpstream = (outcome = 'opened' as const): { calls: [string, string | null][]; upstream: Upstream } => {
  const calls: [string, string | null][] = []
  return {
    calls,
    upstream: {
      preconnect: async (origin: string, authorization: string | null) => {
        calls.push([origin, authorization])
        return outcome
      }
    } as unknown as Upstream
  }
}

describe('preconnectAccount', () => {
  it('asks the pool for the provider origin under the account\'s credential', async () => {
    const { calls, upstream } = fakeUpstream()
    const seen: [string, string | null][] = []
    const out = await preconnectAccount('claude', 'work', {
      upstream,
      credential: async (service, account) => {
        seen.push([service, account])
        return { authorization: 'Bearer tok' }
      }
    })
    expect(out).toBe('opened')
    expect(seen).toEqual([['claude', 'work']])
    expect(calls).toEqual([[PROVIDER_ORIGIN.claude, 'Bearer tok']])
  })

  it('uses the pinned credential for a thread with no account yet', async () => {
    const { calls, upstream } = fakeUpstream()
    await preconnectAccount('codex', null, { upstream, credential: async () => ({ authorization: 'Bearer pinned' }) })
    expect(calls).toEqual([[PROVIDER_ORIGIN.codex, 'Bearer pinned']])
  })

  it('does nothing for a provider off the gateway, or an account with no sign-in, and never throws', async () => {
    const { calls, upstream } = fakeUpstream()
    expect(await preconnectAccount('cursor', 'x', { upstream, credential: async () => ({ authorization: 'a' }) })).toBe('no-provider')
    expect(await preconnectAccount('claude', 'gone', { upstream, credential: async () => null })).toBe('no-credential')
    expect(await preconnectAccount('claude', 'boom', { upstream, credential: async () => { throw new Error('vault locked') } })).toBe('failed')
    expect(calls).toEqual([])
  })
})
