import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TOKENS,
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_THEME_GUIDE,
  HTML_RENDER_THEME_VARIABLES,
  htmlRenderFileName,
  htmlRenderFrameHeight,
  htmlRenderPageUrl,
  htmlRenderReferencesEqual,
  htmlRenderTheme,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
  injectHtmlRenderBootstrap,
  readHtmlRenderContentHeight,
  readHtmlRenderLinkRequest,
  readHtmlRenderReference
} from './htmlRender'

const reference = { sessionId: 'thread-abc', pageId: 'page123', title: 'Chart', height: 420 }

describe('injectHtmlRenderBootstrap', () => {
  it("puts the theme ahead of the page's own head content", () => {
    const html =
      '<!doctype html><html><head><style>:root{--background:red}</style></head><body>x</body></html>'
    const injected = injectHtmlRenderBootstrap(html)
    const themeAt = injected.indexOf('<style id="tc-theme">')
    expect(themeAt).toBeGreaterThan(injected.indexOf('<head>'))
    expect(themeAt).toBeLessThan(injected.indexOf(':root{--background:red}'))
    expect(injected).toContain('<meta charset="utf-8">')
    expect(injected).toContain('name="viewport"')
  })

  it('wraps a document with <html> but no head, and one with only a doctype', () => {
    expect(injectHtmlRenderBootstrap('<html><body>x</body></html>')).toMatch(
      /^<html><head><meta charset="utf-8">.*<\/head><body>x<\/body><\/html>$/s
    )
    expect(injectHtmlRenderBootstrap('<!doctype html><p>x</p>')).toMatch(
      /^<!doctype html><head>.*<\/head><p>x<\/p>$/s
    )
  })

  it('wraps fragments without a head and keeps existing meta tags', () => {
    const fragment =
      '<meta charset="utf-8"><meta name="viewport" content="width=device-width"><p>hi</p>'
    const injected = injectHtmlRenderBootstrap(fragment)
    expect(injected.startsWith('<!doctype html><head>')).toBe(true)
    expect(injected.match(/charset/g)).toHaveLength(1)
    expect(injected.match(/name="viewport"/g)).toHaveLength(1)
    expect(injected.endsWith('<p>hi</p>')).toBe(true)
  })

  it.each(['textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext'])(
    'keeps the bootstrap outside %s content',
    (tag) => {
      const fragment = `<${tag}><head><meta name="viewport"></head></${tag}>`
      const injected = injectHtmlRenderBootstrap(fragment)
      expect(injected.startsWith('<!doctype html><head>')).toBe(true)
      expect(injected.indexOf('<style id="tc-theme">')).toBeLessThan(injected.indexOf(`<${tag}>`))
      expect(injected).toContain('<meta name="viewport" content="width=device-width')
      expect(injected.endsWith(fragment)).toBe(true)
    }
  )

  it.each([
    '<template><head><meta name="viewport"></head></template>',
    '<template><template>inner</template><head><meta name="viewport"></head></template>'
  ])('keeps the bootstrap outside inert template content: %s', (fragment) => {
    const injected = injectHtmlRenderBootstrap(fragment)
    expect(injected.startsWith('<!doctype html><head>')).toBe(true)
    expect(injected.indexOf('<style id="tc-theme">')).toBeLessThan(injected.indexOf('<template>'))
    expect(injected).toContain('<meta name="viewport" content="width=device-width')
    expect(injected.endsWith(fragment)).toBe(true)
  })

  it('ignores tags written inside comments and scripts', () => {
    const html =
      '<!-- copy <head> and <meta name="viewport"> here --><html><head>' +
      '<script>const tag = \'<meta name="viewport">\';</script></head><body>x</body></html>'
    const injected = injectHtmlRenderBootstrap(html)
    expect(injected.indexOf('<style id="tc-theme">')).toBeGreaterThan(
      injected.indexOf('<html><head>')
    )
    expect(injected).toContain('<meta name="viewport" content="width=device-width')
  })
})

describe('readHtmlRenderLinkRequest', () => {
  it('accepts only http(s) URLs in an MCP Apps ui/open-link request', () => {
    const link = (url: unknown) => ({
      jsonrpc: '2.0',
      id: 1,
      method: 'ui/open-link',
      params: { url }
    })
    expect(readHtmlRenderLinkRequest(link('https://example.com/a'))).toEqual({
      id: 1,
      url: 'https://example.com/a'
    })
    expect(readHtmlRenderLinkRequest(link('javascript:alert(1)'))).toBeUndefined()
    expect(readHtmlRenderLinkRequest(link('file:///etc/passwd'))).toBeUndefined()
    expect(
      readHtmlRenderLinkRequest({
        jsonrpc: '2.0',
        method: 'ui/open-link',
        params: { url: 'https://example.com' }
      })
    ).toBeUndefined()
  })
})

describe('readHtmlRenderContentHeight', () => {
  it('reads only the height of an MCP Apps size-changed notification', () => {
    const notification = (params: unknown) => ({
      jsonrpc: '2.0',
      method: 'ui/notifications/size-changed',
      params
    })
    expect(readHtmlRenderContentHeight(notification({ height: 412 }))).toBe(412)
    expect(readHtmlRenderContentHeight(notification({ height: '412' }))).toBe(undefined)
    expect(readHtmlRenderContentHeight(notification({ height: 0 }))).toBe(undefined)
    expect(readHtmlRenderContentHeight({ ...notification({ height: 412 }), method: 'x' })).toBe(
      undefined
    )
  })
})

describe('htmlRenderTheme', () => {
  it('yields every documented variable with values the bootstrap keeps whole', () => {
    const theme = htmlRenderTheme(DEFAULT_TOKENS.dark, 'dark')
    for (const name of HTML_RENDER_THEME_VARIABLES) {
      expect(HTML_RENDER_THEME_GUIDE).toContain(name.replace(/-[1-6]$/, '-1'))
      expect(theme.variables[name]).toMatch(/^[^;{}<>]+$/)
    }
    expect(theme.variables['--background']).toBe(DEFAULT_TOKENS.dark.background)
    expect(theme.variables['--chart-1']).toBe(DEFAULT_TOKENS.dark.accent)
    expect(theme.variables['--muted']).toContain(DEFAULT_TOKENS.dark.foreground)
  })

  it('is an MCP Apps host-context-changed notification and a decodable fragment', () => {
    const theme = htmlRenderTheme(DEFAULT_TOKENS.light, 'light')
    expect(htmlRenderThemeMessage(theme)).toEqual({
      jsonrpc: '2.0',
      method: 'ui/notifications/host-context-changed',
      params: { theme: 'light', styles: { variables: theme.variables } }
    })
    const fragment = htmlRenderThemeFragment(theme)
    expect(JSON.parse(decodeURIComponent(fragment.slice('#tc-theme='.length)))).toEqual(theme)
    expect(fragment).not.toContain('&')
  })
})

describe('readHtmlRenderReference', () => {
  it('clamps height, trims titles and rejects malformed references', () => {
    expect(readHtmlRenderReference({ ...reference, height: 99_999 })?.height).toBe(2000)
    expect(readHtmlRenderReference({ ...reference, title: '  ' })?.title).toBe('HTML')
    expect(readHtmlRenderReference({ ...reference, title: ' x '.repeat(200) })?.title).toHaveLength(
      200
    )
    expect(readHtmlRenderReference({ ...reference, pageId: 4 })).toBeUndefined()
    expect(readHtmlRenderReference({ ...reference, pageId: '../x' })).toBeUndefined()
    expect(readHtmlRenderReference({ ...reference, height: Number.NaN })).toBeUndefined()
    expect(readHtmlRenderReference(null)).toBeUndefined()
  })

  it('names the stored page and a download file', () => {
    expect(htmlRenderPageUrl(reference)).toBe('tempcode-asset://page/thread-abc/page123.html')
    expect(htmlRenderFileName(' Q3: revenue / costs? ')).toBe('Q3 revenue costs.html')
    expect(htmlRenderFileName('')).toBe('Page.html')
  })
})

describe('htmlRenderFrameHeight', () => {
  const measured = readHtmlRenderReference({
    ...reference,
    height: 1500,
    heights: [
      [864, 1403],
      [400, 1290],
      [1000, 1660]
    ]
  })!

  it('takes the taller neighbour between measured widths and holds the ends', () => {
    expect(measured.heights?.map(([width]) => width)).toEqual([400, 864, 1000])
    expect(htmlRenderFrameHeight(measured, 864)).toBe(1403)
    expect(htmlRenderFrameHeight(measured, 559)).toBe(1403)
    expect(htmlRenderFrameHeight(measured, 320)).toBe(1290)
  })

  it('takes the taller layout when a breakpoint falls between measured widths', () => {
    const responsive = readHtmlRenderReference({
      ...reference,
      height: 2000,
      heights: [
        [520, 900],
        [640, 450]
      ]
    })!
    expect(htmlRenderFrameHeight(responsive, 590)).toBe(900)
    expect(htmlRenderFrameHeight(responsive, 640)).toBe(450)
  })

  it('fits a page the frame lays out taller than main measured', () => {
    const fitted = { ...measured, height: 1403 }
    expect(htmlRenderFrameHeight(fitted, 864, 1415)).toBe(1415)
    expect(htmlRenderFrameHeight(fitted, 1400)).toBe(1660)
    expect(htmlRenderFrameHeight(fitted, 864, 5000)).toBe(HTML_RENDER_MAX_HEIGHT)
  })

  it("keeps the agent's height when it asked for a scrolling frame or the page is unmeasured", () => {
    const scrolling = { ...measured, height: 600 }
    expect(htmlRenderFrameHeight(scrolling, 864, 1415)).toBe(600)
    expect(htmlRenderFrameHeight(scrolling, 1400)).toBe(600)
    expect(htmlRenderFrameHeight(reference, 864)).toBe(reference.height)
    expect(htmlRenderFrameHeight(reference, 864, 900)).toBe(reference.height)
    expect(htmlRenderFrameHeight(reference, 864, 300)).toBe(300)
  })

  it('drops a malformed table and compares tables by value', () => {
    expect(readHtmlRenderReference({ ...reference, heights: [[864, 'x']] })?.heights).toBe(
      undefined
    )
    const copy = readHtmlRenderReference(JSON.parse(JSON.stringify(measured)))!
    expect(htmlRenderReferencesEqual(measured, copy)).toBe(true)
    expect(htmlRenderReferencesEqual(measured, { ...copy, heights: [[400, 1290]] })).toBe(false)
  })
})
