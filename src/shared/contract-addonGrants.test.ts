import { describe, expect, it } from 'vitest'
import { ClientRequestSchema } from './contract'
import { METHOD_CAPABILITY } from './capabilities'
import { ADDON_GRANT_METHODS, AddonGrantViewSchema, isAddonGrantMethod } from './contract-addonGrants'

const REQUESTS: { method: string; params?: unknown }[] = [
  { method: 'addons.grant.list' },
  { method: 'addons.grant.list', params: {} },
  { method: 'addons.grant.setFields', params: { id: 'ad_1', fields: { 'X-Api-Key': 'k', OLD: null } } },
  { method: 'addons.grant.clear', params: { id: 'ad_1' } },
  { method: 'addons.grant.refresh', params: { id: 'ad_1' } },
  { method: 'addons.grant.signIn', params: { id: 'ad_1' } },
  { method: 'addons.grant.cancel', params: { id: 'ad_1' } }
]

describe('the add-on grant contract', () => {
  it('parses every request through ClientRequestSchema', () => {
    for (const req of REQUESTS) {
      const parsed = ClientRequestSchema.safeParse({ id: '1', ...req })
      expect(parsed.success, `${req.method}: ${parsed.error?.message}`).toBe(true)
    }
    expect(REQUESTS.map((r) => r.method).filter((m, i, all) => all.indexOf(m) === i)).toEqual([...ADDON_GRANT_METHODS])
  })

  it('refuses a value over 8 KiB and a field map that is not strings', () => {
    expect(ClientRequestSchema.safeParse({ id: '1', method: 'addons.grant.setFields', params: { id: 'a', fields: { K: 'x'.repeat(8_193) } } }).success).toBe(false)
    expect(ClientRequestSchema.safeParse({ id: '1', method: 'addons.grant.setFields', params: { id: 'a', fields: { K: 1 } } }).success).toBe(false)
  })

  it('gives each method its capability: the view read, values and refreshes admin, the sign-in local', () => {
    expect(METHOD_CAPABILITY['addons.grant.list']).toBe('read')
    for (const m of ['addons.grant.setFields', 'addons.grant.clear', 'addons.grant.refresh'] as const) expect(METHOD_CAPABILITY[m], m).toBe('admin')
    for (const m of ['addons.grant.signIn', 'addons.grant.cancel'] as const) expect(METHOD_CAPABILITY[m], m).toBe('local')
  })

  it('a view has no place for a value', () => {
    const view = { addonId: 'ad_1', fields: [{ name: 'K', set: true }], oauth: { signedIn: true, expiresAt: 1, refreshedBy: 'box', refused: false }, signIn: null, gaps: [] }
    expect(AddonGrantViewSchema.parse(view)).toEqual(view)
    expect(AddonGrantViewSchema.parse({ ...view, fields: [{ name: 'K', set: true, value: 'secret' }] }).fields[0]).not.toHaveProperty('value')
    expect(isAddonGrantMethod('addons.grant.signIn')).toBe(true)
    expect(isAddonGrantMethod('addons.list')).toBe(false)
  })
})
