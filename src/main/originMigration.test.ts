import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {}, net: {}, protocol: {}, app: {} }))

const { migrationMarker, readScript, writeScript } = await import('./originMigration')

/** A localStorage stand-in with the two methods the scripts use. */
function fakeStorage(init: Record<string, string>): {
  getItem: (k: string) => string | null
  setItem: (k: string, v: string) => void
  data: Record<string, string>
} {
  const data = { ...init }
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v
    }
  }
}

describe('originMigration scripts', () => {
  it('marker lives in userData', () => {
    expect(migrationMarker('/u/d')).toBe('/u/d/localstorage-migrated')
  })

  it('readScript serialises every entry', () => {
    const localStorage = { a: '1', 'b c': '{"x":2}' }
    const out = new Function('localStorage', `return ${readScript()}`)(localStorage) as string
    expect(JSON.parse(out)).toEqual([
      ['a', '1'],
      ['b c', '{"x":2}']
    ])
  })

  it('writeScript sets only keys the new origin lacks and counts them', () => {
    const storage = fakeStorage({ kept: 'new-origin-value' })
    const entries: Array<[string, string]> = [
      ['kept', 'old-origin-value'],
      ['layout', '{"rail":true}'],
      ['quote', 'it\'s "quoted"   line']
    ]
    const n = new Function('localStorage', `return ${writeScript(entries)}`)(storage) as number
    expect(n).toBe(2)
    expect(storage.data).toEqual({
      kept: 'new-origin-value',
      layout: '{"rail":true}',
      quote: 'it\'s "quoted"   line'
    })
  })

  it('writeScript with nothing to copy sets nothing', () => {
    const storage = fakeStorage({})
    const n = new Function('localStorage', `return ${writeScript([])}`)(storage) as number
    expect(n).toBe(0)
    expect(storage.data).toEqual({})
  })
})
