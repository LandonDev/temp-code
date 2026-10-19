import { describe, expect, it } from 'vitest'
import { assetRequestFor, fencedUnder, mimeFor, pairPageHtml, rewriteCsp } from './ui'

const INDEX = `<!doctype html><html><head><meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; media-src 'self' tempcode-asset:; frame-src tempcode-asset:" />
<title>TempCode</title></head><body></body></html>`

describe('rewriteCsp', () => {
  it('adds the host to connect-src with wss behind https', () => {
    const out = rewriteCsp(INDEX, 'tempcode.example.com', 'https')
    expect(out).toContain("connect-src 'self' ws://127.0.0.1:* ws://localhost:* wss://tempcode.example.com https://tempcode.example.com;")
    expect(out).toContain("frame-src 'self' tempcode-asset:")
    expect(out.match(/Content-Security-Policy/g)).toHaveLength(1)
    expect(rewriteCsp(out, 'h', 'https').match(/frame-src 'self'/g)).toHaveLength(1)
  })
  it('uses ws for a plain http host', () => {
    expect(rewriteCsp(INDEX, '127.0.0.1:7679', 'http')).toContain('ws://127.0.0.1:7679 http://127.0.0.1:7679')
  })
  it('leaves a page without the meta alone', () => {
    expect(rewriteCsp('<html></html>', 'h', 'https')).toBe('<html></html>')
  })
})

describe('mimeFor', () => {
  it('spells the types module scripts and fonts need', () => {
    expect(mimeFor('/x/index-abc.js')).toBe('text/javascript; charset=utf-8')
    expect(mimeFor('/x/a.woff2')).toBe('font/woff2')
    expect(mimeFor('/x/a.wasm')).toBe('application/wasm')
    expect(mimeFor('/x/a.unknown')).toBeUndefined()
  })
})

describe('fencedUnder', () => {
  const root = '/srv/out/renderer'
  it('keeps paths under the root and refuses escapes', () => {
    expect(fencedUnder(root, 'assets/index.js')).toBe('/srv/out/renderer/assets/index.js')
    expect(fencedUnder(root, '/assets/index.js')).toBe('/srv/out/renderer/assets/index.js')
    expect(fencedUnder(root, '../main/index.js')).toBeNull()
    expect(fencedUnder(root, 'assets/../../x')).toBeNull()
    expect(fencedUnder(root, '%2e%2e/x')).toBeNull()
    expect(fencedUnder(root, '%zz')).toBeNull()
    expect(fencedUnder(root, '')).toBeNull()
    expect(fencedUnder(root, 'a%00b')).toBeNull()
  })
})

describe('pairPageHtml', () => {
  it('posts a session exchange and never inlines a code', () => {
    const html = pairPageHtml()
    expect(html).toContain("kind: 'session'")
    expect(html).toContain('location.hash')
    expect(html).toContain("location.replace('/ui/')")
    expect(html).not.toMatch(/tc_[A-Z0-9]{10}/)
  })
})

describe('assetRequestFor', () => {
  it('maps /asset/<host>/<path>?q onto the asset scheme and carries Range', () => {
    const r = assetRequestFor('/asset/file/abc123/clip.mp4?v=9', { method: 'GET', headers: { range: 'bytes=0-99' } })!
    expect(r.url).toBe('tempcode-asset://file/abc123/clip.mp4?v=9')
    expect(r.headers.get('range')).toBe('bytes=0-99')
    expect(assetRequestFor('/asset/logo/a%20b.png', { headers: {} })!.url).toBe('tempcode-asset://logo/a%20b.png')
    expect(assetRequestFor('/asset/page/s/p.html', { method: 'HEAD', headers: {} })!.method).toBe('HEAD')
    expect(assetRequestFor('/asset/', { headers: {} })).toBeNull()
    expect(assetRequestFor('/asset/Logo/x', { headers: {} })).toBeNull()
    expect(assetRequestFor('/assets/index.js', { headers: {} })).toBeNull()
  })
})
