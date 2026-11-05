import { expect, it } from 'vitest'
import { PEER_CATALOG_KEY, PeerCatalogs, readCatalog } from './peerCatalogs'

const store = () => {
  const rows = new Map<string, string>()
  return { rows, getSetting: (k: string) => rows.get(k) ?? null, setSetting: (k: string, v: string | null) => void (v === null ? rows.delete(k) : rows.set(k, v)) }
}

const MUSE = {
  id: 'muse',
  label: 'Muse Code',
  models: [{ id: 'muse-wonder-full-1.0', label: 'Muse Wonder Full 1.0', reasoning: ['low', 'xhigh'] }],
  defaultModel: 'muse-wonder-full-1.0'
}

it('keeps a host catalog as sent, says when it changed, and knows it again after a restart', () => {
  const s = store()
  const a = new PeerCatalogs(s)
  expect(a.set('env_mac', { muse: MUSE })).toBe(true)
  expect(a.set('env_mac', { muse: MUSE })).toBe(false)
  expect(a.modelInfo('env_mac', 'muse', 'muse-wonder-full-1.0')?.reasoning).toEqual(['low', 'xhigh'])
  expect(a.modelInfo('env_mac', 'muse', 'muse-spark-1.3')).toBeUndefined()
  expect(s.rows.has(`${PEER_CATALOG_KEY}env_mac`)).toBe(true)
  const b = new PeerCatalogs(s)
  expect(b.get('env_mac')?.muse?.models[0].id).toBe('muse-wonder-full-1.0')
  expect(b.probedRows()).toEqual([{ provider: 'muse', id: 'muse-wonder-full-1.0' }])
  expect(b.get('env_other')).toBeNull()
})

it('reads only the entries this build knows: a newer provider or a bad row is left out', () => {
  const read = readCatalog({ muse: MUSE, hal: { id: 'hal', label: 'HAL', models: [], defaultModel: '' }, codex: { id: 'codex' } })
  expect(Object.keys(read)).toEqual(['muse'])
  expect(readCatalog(null)).toEqual({})
})
