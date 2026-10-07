import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/data' },
  net: {},
  protocol: {}
}))

const { resolveAssetPath } = await import('./assets')

describe('resolveAssetPath', () => {
  it('maps logos and pages to their own roots and nothing else', () => {
    expect(resolveAssetPath('tempcode-asset://logo/acme.png')).toBe(join('/data', 'project-logos', 'acme.png'))
    expect(resolveAssetPath('tempcode-asset://page/sess-1/abc.html')).toBe(
      join('/data', 'html-renders', 'sess-1', 'abc.html')
    )
    expect(resolveAssetPath('tempcode-asset://other/x')).toBeNull()
    expect(resolveAssetPath('file:///data/html-renders/s/x.html')).toBeNull()
  })

  it('fences pages to the html-renders root and to .html files', () => {
    expect(resolveAssetPath('tempcode-asset://page/..%2F..%2Ftemp-code.db')).toBeNull()
    expect(resolveAssetPath('tempcode-asset://page/sess-1/..%2F..%2Fproject-logos%2Fa.png')).toBeNull()
    expect(resolveAssetPath('tempcode-asset://page/sess-1/notes.txt')).toBeNull()
    expect(resolveAssetPath('tempcode-asset://page/')).toBeNull()
  })
})
