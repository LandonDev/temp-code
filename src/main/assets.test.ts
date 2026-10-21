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

const { handleAssetRequest, resolveAssetPath, setRemotePages } = await import('./assets')

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
