import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { assetRequestFor, createUiHandler, fencedUnder, mimeFor, rewriteCsp } from './ui'

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

describe('assetRequestFor', () => {
  it('maps /asset/<host>/<path>?q onto the asset scheme and carries Range', () => {
    const r = assetRequestFor('/asset/file/abc123/clip.mp4?v=9', { method: 'GET', headers: { range: 'bytes=0-99' } })!
    expect(r.url).toBe('tempcode-asset://file/abc123/clip.mp4?v=9')
    expect(r.headers.get('range')).toBe('bytes=0-99')
    expect(assetRequestFor('/asset/logo/a%20b.png', { headers: {} })!.url).toBe('tempcode-asset://logo/a%20b.png')
    expect(assetRequestFor('/asset/page/s/p.html', { method: 'HEAD', headers: {} })!.method).toBe('HEAD')
    // The host a page lives on rides the route's query.
    expect(assetRequestFor('/asset/page/s/p.html?host=env_box', { headers: {} })!.url).toBe('tempcode-asset://page/s/p.html?host=env_box')
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

async function serve(path: string, rendererDir: string, signedIn: boolean | 'refused' = true): Promise<FakeRes> {
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
    principal: async () => {
      if (signedIn === 'refused') throw new Error('session expired')
      return signedIn ? ({ session: { id: 's' }, principal: { audience: 'client' } } as never) : null
    },
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

  it('/pair answers its policy as a header equal to the meta, the script and the style nonced', async () => {
    const res = await serve('/pair', dir, false)
    expect(res.status).toBe(200)
    const policy = String(res.headers['Content-Security-Policy'])
    expect(res.body).toContain(`content="${policy}"`)
    const nonce = /script-src 'nonce-([^']+)'/.exec(policy)?.[1]
    expect(nonce).toBeTruthy()
    expect(policy).toContain(`style-src 'nonce-${nonce}'`)
    expect(policy).not.toContain('unsafe-inline')
    expect(res.body).toContain(`<style nonce="${nonce}">`)
    expect(res.body).toContain(`<script nonce="${nonce}">`)
    expect(res.headers['Cache-Control']).toBe('no-store')
  })

  it('a chunk without a session is a plain 401, never a redirect', async () => {
    const res = await serve('/ui/assets/SettingsView-def.js', dir, false)
    expect(res.status).toBe(401)
    expect(res.headers['Cache-Control']).toBe('no-store')
  })

  it('the document sends a browser with no cookie to /pair, and one whose cookie was refused to /pair?signed-out', async () => {
    const fresh = await serve('/ui/', dir, false)
    expect(fresh.status).toBe(302)
    expect(fresh.headers.Location).toBe('/pair')
    const refused = await serve('/ui/', dir, 'refused')
    expect(refused.status).toBe(302)
    expect(refused.headers.Location).toBe('/pair?signed-out')
    expect((await serve('/ui/assets/SettingsView-def.js', dir, 'refused')).status).toBe(401)
  })

  it('a chunk that is not on disk is 404', async () => {
    const res = await serve('/ui/assets/Nope-000.js', dir)
    expect(res.status).toBe(404)
  })
})
