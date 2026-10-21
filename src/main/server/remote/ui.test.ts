import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { assetRequestFor, createUiHandler, fencedUnder, mimeFor, pairPageHtml, rewriteCsp } from './ui'

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
    const html = pairPageHtml('n0nce+Abc/==')
    expect(html).toContain("kind: 'session'")
    expect(html).toContain('location.hash')
    expect(html).toContain("location.replace('/ui/')")
    expect(html).not.toMatch(/tc_[A-Z0-9]{10}/)
  })
  it('allows its script by nonce only, never inline (R2 L3)', () => {
    const html = pairPageHtml('n0nce+Abc/==')
    expect(html).toMatch(/script-src 'nonce-n0nce\+Abc\/=='; /)
    expect(html).toContain('<script nonce="n0nce+Abc/==">')
    expect(html).not.toMatch(/script-src[^;]*unsafe-inline/)
    expect(html.match(/<script/g)).toHaveLength(1)
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

/** A response that collects what the handler wrote (the file is piped in). */
class FakeRes extends Writable {
  status = 0
  headers: Record<string, string | number> = {}
  body = ''
  writeHead(status: number, headers: Record<string, string | number>): this {
    this.status = status
    this.headers = headers
    return this
  }
  _write(chunk: Buffer, _enc: string, cb: () => void): void {
    this.body += chunk.toString()
    cb()
  }
}

async function serve(path: string, rendererDir: string, signedIn = true): Promise<FakeRes> {
  const handler = createUiHandler({ rendererDir })
  const res = new FakeRes()
  const done = new Promise<void>((resolve) => res.on('finish', resolve))
  const answered = await handler({
    req: { method: 'GET', headers: {}, url: path } as never,
    res: res as never,
    path,
    query: new URLSearchParams(),
    ip: '127.0.0.1',
    proto: 'https',
    host: 'tempcode.example',
    origin: 'https://tempcode.example',
    principal: async () => (signedIn ? ({ session: { id: 's' }, principal: { audience: 'client' } } as never) : null),
    setCookie: () => {}
  })
  expect(answered).toBe(true)
  await done
  return res
}

describe('createUiHandler: the lazy chunks over /ui', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-ui-'))
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><script type="module" src="./assets/index-abc.js"></script>')
  writeFileSync(join(dir, 'assets', 'index-abc.js'), 'import("./SettingsView-def.js")')
  writeFileSync(join(dir, 'assets', 'SettingsView-def.js'), 'export const SettingsView = 1')

  it('serves a hashed chunk as an immutable module script behind the cookie', async () => {
    const res = await serve('/ui/assets/SettingsView-def.js', dir)
    expect(res.status).toBe(200)
    expect(res.headers['Content-Type']).toBe('text/javascript; charset=utf-8')
    expect(res.headers['Cache-Control']).toBe('public, max-age=31536000, immutable')
    expect(res.body).toBe('export const SettingsView = 1')
  })

  it('a chunk without a session is a plain 401, never a redirect', async () => {
    const res = await serve('/ui/assets/SettingsView-def.js', dir, false)
    expect(res.status).toBe(401)
    expect(res.headers['Cache-Control']).toBe('no-store')
  })

  it('a chunk that is not on disk is 404', async () => {
    const res = await serve('/ui/assets/Nope-000.js', dir)
    expect(res.status).toBe(404)
  })
})
