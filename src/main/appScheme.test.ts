import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ net: {}, protocol: {}, app: {} }))

const { APP_SCHEME, appIndexUrl, mimeFor, resolveAppPath } = await import('./appScheme')

const ROOT = '/app/Contents/Resources/app/out/renderer'

describe('resolveAppPath', () => {
  it('serves files under the renderer root', () => {
    expect(resolveAppPath('tempcode-app://renderer/index.html', ROOT)).toBe(`${ROOT}/index.html`)
    expect(resolveAppPath('tempcode-app://renderer/assets/index-abc.js', ROOT)).toBe(
      `${ROOT}/assets/index-abc.js`
    )
  })
  it('decodes the path and drops the query', () => {
    expect(resolveAppPath('tempcode-app://renderer/a%20b.css?v=1#x', ROOT)).toBe(`${ROOT}/a b.css`)
  })
  it('refuses traversal out of the root', () => {
    // The URL parser folds /../ and /%2e%2e/ before we see them (both land
    // inside the root); an encoded slash survives parsing and is caught
    // after decoding.
    expect(resolveAppPath('tempcode-app://renderer/../main/index.js', ROOT)).toBe(
      `${ROOT}/main/index.js`
    )
    expect(resolveAppPath('tempcode-app://renderer/%2e%2e/main/index.js', ROOT)).toBe(
      `${ROOT}/main/index.js`
    )
    expect(resolveAppPath('tempcode-app://renderer/..%2fmain/index.js', ROOT)).toBeNull()
    expect(resolveAppPath('tempcode-app://renderer/assets/..%2f..%2fx', ROOT)).toBeNull()
    expect(resolveAppPath('tempcode-app://renderer/%2e%2e%2f%2e%2e%2fetc/passwd', ROOT)).toBeNull()
  })
  it('refuses other hosts, schemes, the bare root and junk', () => {
    expect(resolveAppPath('tempcode-app://other/index.html', ROOT)).toBeNull()
    expect(resolveAppPath('tempcode-asset://renderer/index.html', ROOT)).toBeNull()
    expect(resolveAppPath('file:///etc/passwd', ROOT)).toBeNull()
    expect(resolveAppPath('tempcode-app://renderer/', ROOT)).toBeNull()
    expect(resolveAppPath('tempcode-app://renderer/%zz', ROOT)).toBeNull()
    expect(resolveAppPath('not a url', ROOT)).toBeNull()
  })
})

describe('appIndexUrl / mimeFor', () => {
  it('names the index on the renderer host', () => {
    expect(appIndexUrl()).toBe(`${APP_SCHEME}://renderer/index.html`)
  })
  it('types scripts, styles, fonts and html; leaves the rest to the file loader', () => {
    expect(mimeFor('/x/index-abc.js')).toBe('text/javascript; charset=utf-8')
    expect(mimeFor('/x/editor.worker-abc.JS')).toBe('text/javascript; charset=utf-8')
    expect(mimeFor('/x/index.css')).toBe('text/css; charset=utf-8')
    expect(mimeFor('/x/codicon.ttf')).toBe('font/ttf')
    expect(mimeFor('/x/index.html')).toBe('text/html; charset=utf-8')
    expect(mimeFor('/x/monocode.png')).toBe('image/png')
    expect(mimeFor('/x/thing.unknown')).toBeUndefined()
  })
})
