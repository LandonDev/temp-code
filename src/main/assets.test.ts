import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const dataDir = mkdtempSync(join(tmpdir(), 'tc-assets-'))
afterAll(() => rmSync(dataDir, { recursive: true, force: true }))

vi.mock('electron', () => ({
  app: { getPath: () => dataDir },
  net: {},
  protocol: {}
}))

const { handleAssetRequest, resolveAssetPath, setRemoteMedia, setRemotePages } = await import('./assets')

describe('a page of another host', () => {
  const read = vi.fn(async (_host: string, sessionId: string, pageId: string) =>
    sessionId === 'sess-1' && pageId === 'abc' ? '<p>from the box</p>' : null
  )
  setRemotePages({ environmentId: 'env_me', read })
  const page = (host: string, path = '/sess-1/abc.html') =>
    handleAssetRequest(new Request(`tempcode-asset://page${path}?host=${host}`))

  it('is fetched over the peer link once and served from the cache after', async () => {
    const first = await page('env_box')
    expect(first.status).toBe(200)
    expect(first.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(await first.text()).toBe('<p>from the box</p>')
    expect(read).toHaveBeenCalledWith('env_box', 'sess-1', 'abc')
    expect(readFileSync(join(dataDir, 'html-renders-remote', 'env_box', 'sess-1', 'abc.html'), 'utf8')).toBe(
      '<p>from the box</p>'
    )
    expect((await page('env_box')).status).toBe(200)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('answers not found for a page the host lacks, and 503 when the host is out of reach', async () => {
    expect((await page('env_box', '/sess-1/missing.html')).status).toBe(404)
    read.mockRejectedValueOnce(new Error('The box is not connected'))
    const down = await page('env_box', '/sess-2/xyz.html')
    expect(down.status).toBe(503)
    expect(await down.text()).toContain('The box is not connected')
  })

  it('reads this host\'s own pages from disk, and fences the host segment', async () => {
    expect((await page('env_me')).status).toBe(404)
    expect(read).toHaveBeenCalledTimes(3)
    expect((await page('..%2F..')).status).toBe(404)
    expect(read).toHaveBeenCalledTimes(3)
  })
})

describe('media of another host', () => {
  const bytes = Buffer.from('0123456789abcdefghij')
  const token = 'a'.repeat(32)
  const read = vi.fn(async (_host: string, tok: string, offset: number, length: number) =>
    tok === token
      ? { dataBase64: bytes.subarray(offset, offset + length).toString('base64'), mime: 'image/png', size: bytes.length, mtimeMs: 1 }
      : null
  )
  setRemoteMedia({ environmentId: 'env_me', read })
  const media = (host: string, init?: RequestInit, tok = token) =>
    handleAssetRequest(new Request(`tempcode-asset://file/${tok}/shot.png?v=1&host=${host}`, init))

  it('streams the whole file from the host with the headers a viewer needs', async () => {
    read.mockClear()
    const res = await media('env_box')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    expect(res.headers.get('Content-Length')).toBe('20')
    expect(res.headers.get('Accept-Ranges')).toBe('bytes')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes)
    // One read for a file under the chunk size: the first answer carried it all.
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith('env_box', token, 0, 2 * 1024 * 1024)
  })

  it('answers a Range with 206 and exactly those bytes, a suffix range too, and 416 past the end', async () => {
    const part = await media('env_box', { headers: { Range: 'bytes=4-7' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('Content-Range')).toBe('bytes 4-7/20')
    expect(Buffer.from(await part.arrayBuffer()).toString()).toBe('4567')
    const tail = await media('env_box', { headers: { Range: 'bytes=-3' } })
    expect(tail.status).toBe(206)
    expect(Buffer.from(await tail.arrayBuffer()).toString()).toBe('hij')
    const open = await media('env_box', { headers: { Range: 'bytes=18-' } })
    expect(Buffer.from(await open.arrayBuffer()).toString()).toBe('ij')
    expect((await media('env_box', { headers: { Range: 'bytes=40-' } })).status).toBe(416)
    const head = await media('env_box', { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.body).toBeNull()
  })

  it('answers not found for a token the host lacks, 503 when the host is out of reach, and serves its own tokens itself', async () => {
    expect((await media('env_box', undefined, 'b'.repeat(32))).status).toBe(404)
    read.mockRejectedValueOnce(new Error('The box is not connected'))
    const down = await media('env_box')
    expect(down.status).toBe(503)
    expect(await down.text()).toContain('The box is not connected')
    read.mockClear()
    // This host's own id on the URL: the local token table, which has no such token here.
    expect((await media('env_me')).status).toBe(404)
    expect(read).not.toHaveBeenCalled()
  })
})

describe('resolveAssetPath', () => {
  it('maps logos and pages to their own roots and nothing else', () => {
    expect(resolveAssetPath('tempcode-asset://logo/acme.png')).toBe(join(dataDir, 'project-logos', 'acme.png'))
    expect(resolveAssetPath('tempcode-asset://page/sess-1/abc.html')).toBe(
      join(dataDir, 'html-renders', 'sess-1', 'abc.html')
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
