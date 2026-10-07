import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  findLocalImages,
  HtmlRenderImageTooLargeError,
  HtmlRenderImagesNotFoundError,
  HtmlRenderPageTooLargeError,
  inlineLocalImages,
  isImageBytes,
  MAX_IMAGE_BYTES,
  MAX_PAGE_BYTES,
  prepare,
  preview,
  publish,
  removePages,
  setHtmlPreviewer,
  setHtmlRenderRoot
} from './htmlRender'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)])

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-html-'))
  writeFileSync(join(dir, 'shot.png'), PNG)
  writeFileSync(join(dir, 'notes.svg'), '<?xml version="1.0"?><!-- c --><svg xmlns="x"/>')
  writeFileSync(join(dir, 'fake.png'), 'SECRET=hunter2')
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))
afterEach(() => setHtmlPreviewer(null))

describe('findLocalImages', () => {
  it('finds quoted absolute paths, CSS url() and JS strings; skips relative, data and protocol-relative', () => {
    const html = [
      '<img src="/abs/a.png">',
      "<div style=\"background:url(/abs/b.webp)\">",
      "<script>const s = '/abs/c.jpg'; const w = `C:\\\\x\\\\d.gif`</script>",
      '<img src="rel/e.png"><img src="//cdn/f.png"><img src="data:image/png;base64,AA">',
      '<img src="https://x/g.png">'
    ].join('')
    expect(findLocalImages(html).map((m) => m.path)).toEqual([
      '/abs/a.png',
      '/abs/b.webp',
      '/abs/c.jpg',
      'C:\\\\x\\\\d.gif'
    ])
  })
})

describe('isImageBytes', () => {
  it('reads magic bytes and svg roots, not names', () => {
    expect(isImageBytes(PNG)).toBe(true)
    expect(isImageBytes(Buffer.from('<?xml version="1.0"?>\n<!DOCTYPE svg [ <!ENTITY a "x>"> ]>\n<svg/>'))).toBe(true)
    expect(isImageBytes(Buffer.from('<svgx/>'))).toBe(false)
    expect(isImageBytes(Buffer.from('SECRET=hunter2'))).toBe(false)
    expect(isImageBytes(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe(true)
  })
})

describe('inlineLocalImages', () => {
  it('inlines readable images as data URIs and lists the rest as missing', async () => {
    const shot = join(dir, 'shot.png')
    const svg = join(dir, 'notes.svg')
    const html = `<img src="${shot}"><div style="background:url(${svg})"><img src="${join(dir, 'nope.png')}"><img src="${join(dir, 'fake.png')}">`
    const result = await inlineLocalImages(html)
    expect(result.html).toContain(`src="data:image/png;base64,${PNG.toString('base64')}"`)
    expect(result.html).toContain('url(data:image/svg+xml;base64,')
    expect(result.html).toContain(join(dir, 'nope.png'))
    expect(result.html).toContain(join(dir, 'fake.png'))
    expect(result.missing).toEqual([join(dir, 'nope.png'), join(dir, 'fake.png')])
  })

  it('rejects an image over the limit and a page over the cap with messages that say what to do', async () => {
    const big = join(dir, 'big.png')
    writeFileSync(big, Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]))
    await expect(inlineLocalImages(`<img src="${big}">`)).rejects.toThrow(HtmlRenderImageTooLargeError)
    await expect(inlineLocalImages(`<img src="${big}">`)).rejects.toThrow(/at most 10\.0 MiB/)
    rmSync(big)
    const three = join(dir, 'nine.png')
    writeFileSync(three, Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024)]))
    const page = Array.from({ length: 3 }, () => `<img src="${three}">`).join('')
    await expect(inlineLocalImages(page)).rejects.toThrow(HtmlRenderPageTooLargeError)
    await expect(inlineLocalImages(page)).rejects.toThrow(
      new RegExp(`the limit is ${(MAX_PAGE_BYTES / 1024 / 1024).toFixed(1)} MiB`)
    )
    rmSync(three)
  })
})

describe('prepare and preview', () => {
  it('prepare injects the bootstrap first and fails on missing images', async () => {
    const page = await prepare(`<p>hi</p><img src="${join(dir, 'shot.png')}">`)
    expect(page.startsWith('<!doctype html><head><meta charset="utf-8">')).toBe(true)
    expect(page).toContain('data:image/png;base64,')
    await expect(prepare(`<img src="${join(dir, 'nope.png')}">`)).rejects.toThrow(
      HtmlRenderImagesNotFoundError
    )
  })

  it('preview clamps the width, defaults to dark and reports missing images', async () => {
    const calls: unknown[] = []
    setHtmlPreviewer({
      preview: async (input) => {
        calls.push(input)
        return { png: 'AAAA', contentHeight: 300, capturedHeight: 300, consoleMessages: [] }
      },
      measure: async () => []
    })
    const result = await preview({ html: `<img src="${join(dir, 'nope.png')}">`, width: 9000 })
    expect(result.width).toBe(1600)
    expect(result.missingImages).toEqual([join(dir, 'nope.png')])
    expect(result.png).toBe('AAAA')
    expect(calls[0]).toMatchObject({ width: 1600, appearance: 'dark' })
    expect((calls[0] as { html: string }).html).toContain('<style id="tc-theme">')
  })

  it('preview without a previewer says so', async () => {
    await expect(preview({ html: '<p/>' })).rejects.toThrow(/not available/)
  })
})

describe('publish and removePages', () => {
  it('writes the page under the root and returns a clamped reference with sorted heights', async () => {
    const root = join(dir, 'renders')
    mkdirSync(root)
    setHtmlRenderRoot(root)
    setHtmlPreviewer({
      preview: async () => {
        throw new Error('unused')
      },
      measure: async (_html, widths) => widths.map((w) => [w, 1000 - w] as const).reverse()
    })
    const reference = await publish({
      sessionId: 'sess-1',
      html: '<p>x</p>',
      title: '  Chart  ',
      height: 99_999
    })
    expect(reference).toMatchObject({ sessionId: 'sess-1', title: 'Chart', height: 2000 })
    expect(reference.pageId).toMatch(/^[\w-]{16}$/)
    expect(reference.heights?.map(([w]) => w)).toEqual([320, 400, 480, 560, 640, 728, 800, 864])
    const file = join(root, 'sess-1', `${reference.pageId}.html`)
    expect(readFileSync(file, 'utf8')).toContain('<p>x</p>')

    await removePages(['sess-1', '../escape'])
    expect(existsSync(join(root, 'sess-1'))).toBe(false)
    expect(existsSync(root)).toBe(true)
  })

  it('publishes without heights when measuring fails', async () => {
    setHtmlRenderRoot(join(dir, 'renders'))
    setHtmlPreviewer({
      preview: async () => {
        throw new Error('unused')
      },
      measure: async () => {
        throw new Error('window gone')
      }
    })
    const reference = await publish({ sessionId: 's2', html: '<p/>', title: 'T', height: 100 })
    expect(reference.heights).toBeUndefined()
    await removePages(['s2'])
  })
})
