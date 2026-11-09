import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configure, vault, type ServiceId } from 'aliax-core'
import { ADDON_SERVICE, type AddonGrantBlob } from '@shared/addonGrant'
import type { AddonRow, AddonSpec } from '@shared/contract-addons'
import { addonGrantHook, onAddonSecretSaved, resolveGrant, seamGrantSource, grantSourceFor, vaultGrantSource } from './grants'

const stdio = (over: Partial<Extract<AddonSpec, { transport: 'stdio' }>> = {}): AddonSpec => ({ transport: 'stdio', command: 'x', args: [], env: [], auth: 'none', ...over })
const http = (over: Partial<Extract<AddonSpec, { transport: 'http' }>> = {}): AddonSpec => ({ transport: 'http', url: 'https://x.test/mcp', headers: [], auth: 'none', ...over })
const blob = (fields: Record<string, string>, accessToken?: string): AddonGrantBlob => ({
  v: 1,
  mintedBy: 'app',
  addonId: 'ad_1',
  fields,
  ...(accessToken !== undefined
    ? { oauth: { clientId: 'c', redirectPort: 4000, authorizationUrl: 'https://a.test/auth', tokenUrl: 'https://a.test/token', accessToken } }
    : {})
})

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-grants-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('resolveGrant', () => {
  it('needs nothing for auth none', () => {
    expect(resolveGrant(stdio(), null)).toMatchObject({ ok: true, env: {}, headers: {} })
  })

  it('maps fields to a stdio server\'s env and an http server\'s headers', () => {
    expect(resolveGrant(stdio({ env: ['A', 'B'], auth: 'fields' }), blob({ A: '1', B: '2', C: '3' }))).toMatchObject({ ok: true, env: { A: '1', B: '2' }, headers: {} })
    expect(resolveGrant(http({ headers: ['X-Api-Key'], auth: 'fields' }), blob({ 'X-Api-Key': 'k' }))).toMatchObject({ ok: true, env: {}, headers: { 'X-Api-Key': 'k' } })
  })

  it('hands an oauth token to tokenEnv or Authorization', () => {
    expect(resolveGrant(stdio({ env: [], tokenEnv: 'TOKEN', auth: 'oauth' }), blob({}, 'tok'))).toMatchObject({ ok: true, env: { TOKEN: 'tok' } })
    expect(resolveGrant(http({ auth: 'oauth' }), blob({}, 'tok'))).toMatchObject({ ok: true, headers: { Authorization: 'Bearer tok' } })
  })

  it('names the gaps: a missing field, no sign-in', () => {
    expect(resolveGrant(stdio({ env: ['A', 'B'], auth: 'fields' }), blob({ A: '1' }))).toEqual({ ok: false, gaps: ['B'] })
    expect(resolveGrant(http({ auth: 'oauth' }), blob({}))).toEqual({ ok: false, gaps: ['sign-in'] })
    expect(resolveGrant(stdio({ env: ['A'], auth: 'fields' }), null)).toEqual({ ok: false, gaps: ['A'] })
  })

  it('digests the values, so a change of value is a change of digest whatever the key order', () => {
    const spec = stdio({ env: ['A', 'B'], auth: 'fields' })
    const one = resolveGrant(spec, blob({ A: '1', B: '2' }))
    const same = resolveGrant(spec, blob({ B: '2', A: '1' }))
    const other = resolveGrant(spec, blob({ A: '1', B: '3' }))
    expect(one.ok && same.ok && one.digest === same.digest).toBe(true)
    expect(one.ok && other.ok && one.digest !== other.digest).toBe(true)
  })
})

describe('the test seam', () => {
  const row = { id: 'ad_1', name: 'fake' } as AddonRow
  const store = { get: (id: string) => (id === 'ad_1' ? row : null) }

  it('is refused without TEMP_CODE_USER_DATA, and the vault serves then', () => {
    expect(() => seamGrantSource(join(dir, 'g.json'), store, () => {}, {})).toThrow('only with TEMP_CODE_USER_DATA')
    expect(grantSourceFor(store, () => {}, { TEMP_CODE_ADDON_GRANTS: join(dir, 'g.json') })).toBe(vaultGrantSource)
  })

  it('reads by name on every ask and calls back on a change of the file', async () => {
    const file = join(dir, 'g.json')
    writeFileSync(file, JSON.stringify({ fake: { fields: { FAKE_TOKEN: 'one' } } }))
    let changes = 0
    const source = grantSourceFor(store, () => changes++, { TEMP_CODE_ADDON_GRANTS: file, TEMP_CODE_USER_DATA: dir })
    try {
      expect(await source.read('ad_1')).toMatchObject({ addonId: 'ad_1', fields: { FAKE_TOKEN: 'one' } })
      expect(await source.read('ad_other')).toBeNull()
      writeFileSync(file, JSON.stringify({ fake: { fields: { FAKE_TOKEN: 'two' } } }))
      const end = Date.now() + 5_000
      while (changes === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 50))
      expect(changes).toBeGreaterThan(0)
      expect(await source.read('ad_1')).toMatchObject({ fields: { FAKE_TOKEN: 'two' } })
    } finally {
      source.close?.()
    }
  })
})

describe('the vault source', () => {
  it('parses a saved blob, answers null on garbage, and a save reaches the host hook', async () => {
    configure({ dataDir: dir, fetch: async () => new Response(null), secrets: { mode: 'fileKey', path: join(dir, 'vault.key') }, environmentId: 'env_test' })
    expect(await vaultGrantSource.read('ad_1')).toBeNull()
    vault.saveSecret(ADDON_SERVICE as ServiceId, 'ad_1', JSON.stringify(blob({ A: '1' })))
    expect(await vaultGrantSource.read('ad_1')).toMatchObject({ addonId: 'ad_1', fields: { A: '1' } })
    vault.saveSecret(ADDON_SERVICE as ServiceId, 'ad_2', 'not json')
    expect(await vaultGrantSource.read('ad_2')).toBeNull()
    const told: string[] = []
    addonGrantHook.current = (id) => told.push(id)
    onAddonSecretSaved('claude', 'x')
    onAddonSecretSaved(ADDON_SERVICE, 'ad_1')
    addonGrantHook.current = null
    expect(told).toEqual(['ad_1'])
  })
})
