import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import { SESSION_NEEDS_CLIENT } from './auth'
import { PAIR_INVALID_LINE, PAIR_TOKENS, pairPageCsp, pairPageHtml, pairPageScript } from './pairPage'

describe('pairPageHtml', () => {
  it('allows its script and its style by nonce only, never inline, with one policy for the meta and the header (R2 L3)', () => {
    const html = pairPageHtml('n0nce+Abc/==')
    expect(html).toContain(`content="${pairPageCsp('n0nce+Abc/==')}"`)
    expect(html).toMatch(/script-src 'nonce-n0nce\+Abc\/=='; /)
    expect(html).toMatch(/style-src 'nonce-n0nce\+Abc\/=='; /)
    expect(html).toContain('<script nonce="n0nce+Abc/==">')
    expect(html).toContain('<style nonce="n0nce+Abc/==">')
    expect(html).not.toContain('unsafe-inline')
    expect(html.match(/<script/g)).toHaveLength(1)
    expect(html.match(/<style/g)).toHaveLength(1)
  })
  it('the refused line is one sentence', () => {
    expect(PAIR_INVALID_LINE.match(/\./g)).toHaveLength(1)
    expect(PAIR_INVALID_LINE.endsWith('.')).toBe(true)
  })
  it('carries no code, no key and no literal colour outside the tokens', () => {
    const html = pairPageHtml('n')
    expect(html).not.toMatch(/tc_[A-Za-z0-9]{6}/)
    const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>')).replace(/--[\w-]+: [^;]+;/g, '')
    expect(style).not.toMatch(/#[0-9a-f]{3,6}\b|oklch\(|rgb\(|hsl\(/i)
  })
  it('the script parses', () => {
    expect(() => new Function(pairPageScript())).not.toThrow()
  })
})

/** Every declaration of `:root`, `@theme` and `html.theme-light` in index.css, var() resolved. */
function appTokens(): { dark: Record<string, string>; light: Record<string, string> } {
  const css = readFileSync(join(__dirname, '../../../renderer/src/index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const dark: Record<string, string> = {}
  const light: Record<string, string> = {}
  for (const block of css.matchAll(/(:root|@theme|html\.theme-light)\s*\{([^}]*)\}/g)) {
    const into = block[1] === 'html.theme-light' ? light : dark
    for (const decl of block[2].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) into[decl[1]] = decl[2].replace(/\s+/g, ' ').trim()
  }
  const resolve = (table: Record<string, string>, value: string): string =>
    value.replace(/^var\(--([\w-]+)\)$/, (_m, name: string) => resolve(table, table[name] ?? ''))
  const all = { ...dark, ...light }
  return {
    dark: Object.fromEntries(Object.entries(dark).map(([k, v]) => [k, resolve(dark, v)])),
    light: Object.fromEntries(Object.entries(all).map(([k, v]) => [k, resolve(all, v)]))
  }
}

describe('PAIR_TOKENS', () => {
  it('equals the app tokens, dark and light', () => {
    const app = appTokens()
    for (const [name, value] of Object.entries(PAIR_TOKENS.dark)) expect([name, value]).toEqual([name, app.dark[name]])
    for (const [name, value] of Object.entries(PAIR_TOKENS.light)) expect([name, value]).toEqual([name, app.light[name]])
    for (const [name, value] of Object.entries(PAIR_TOKENS.shared)) {
      expect([name, value]).toEqual([name, app.dark[name]])
      expect(app.light[name]).toBe(app.dark[name])
    }
  })
})

interface Answer {
  status: number
  body?: unknown
  retryAfter?: string
}

/** The page in its own document, with `fetch`, `location.replace` and the clipboard stubbed. */
function page(url: string, answers: Array<Answer | 'offline'>) {
  const html = pairPageHtml('n').replace(/<script[\s\S]*<\/script>/, '')
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' })
  const { window } = dom
  const posts: Array<Record<string, unknown>> = []
  const fetch = vi.fn(async (_url: string, init: { body: string }) => {
    posts.push(JSON.parse(init.body))
    const next = answers.shift()
    if (!next || next === 'offline') throw new TypeError('Failed to fetch')
    return {
      ok: next.status < 300,
      status: next.status,
      headers: { get: (name: string) => (name === 'Retry-After' ? (next.retryAfter ?? null) : null) },
      json: async () => next.body ?? {}
    }
  })
  const replace = vi.fn()
  const location = {
    get hash() {
      return window.location.hash
    },
    get pathname() {
      return window.location.pathname
    },
    get search() {
      return window.location.search
    },
    replace
  }
  const writeText = vi.fn(async () => {})
  Object.defineProperty(window, 'isSecureContext', { value: true })
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText } })
  new window.Function('location', 'fetch', pairPageScript())(location, fetch)
  const $ = (id: string) => window.document.getElementById(id) as HTMLElement & HTMLInputElement & HTMLButtonElement
  const submit = async () => {
    $('go').click()
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
  }
  return { window, $, posts, replace, writeText, submit }
}

describe('the pair page', () => {
  it('shows a linked code as text with one button and redeems nothing on load', () => {
    const p = page('https://h.example/pair#ABCDE-FGHIJ', [])
    expect(p.$('code').tagName).toBe('DIV')
    expect(p.$('code').textContent).toBe('ABCDE-FGHIJ')
    expect(p.window.document.querySelectorAll('button')).toHaveLength(1)
    expect(p.$('go').textContent).toBe('Pair')
    expect(p.posts).toHaveLength(0)
    expect(p.$('line').textContent).toBe('')
  })

  it('pairs a session, strips the fragment first and goes to /ui/', async () => {
    const p = page('https://h.example/pair#ABCDE-FGHIJ', [{ status: 200, body: { caps: ['read'] } }])
    await p.submit()
    expect(p.posts).toEqual([{ code: 'ABCDE-FGHIJ', kind: 'session', name: expect.any(String) }])
    expect(p.window.location.hash).toBe('')
    expect(p.$('line').textContent).toBe('Paired.')
    expect(p.replace).toHaveBeenCalledWith('/ui/')
  })

  it('a refused code says the one sentence and turns into an empty focused field', async () => {
    const p = page('https://h.example/pair#ABCDE-FGHIJ', [{ status: 401, body: { error: 'invalid or expired pairing code' } }])
    await p.submit()
    expect(p.$('line').textContent).toBe(PAIR_INVALID_LINE)
    expect(p.$('line').className).toBe('failed')
    expect(p.$('code').tagName).toBe('INPUT')
    expect(p.$('code').value).toBe('')
    expect(p.window.document.activeElement).toBe(p.$('code'))
    expect(p.$('go').disabled).toBe(false)
  })

  it('a malformed code (a 400 that is not the bot case) reads the same line as an unknown one', async () => {
    const p = page('https://h.example/pair#ABCDE', [{ status: 400, body: { error: 'code must look like XXXXX-XXXXX' } }])
    await p.submit()
    expect(p.$('line').textContent).toBe(PAIR_INVALID_LINE)
    expect(p.$('line').className).toBe('failed')
    expect(p.$('code').tagName).toBe('INPUT')
    expect(p.window.document.activeElement).toBe(p.$('code'))
  })

  it('a typed code: an empty field posts nothing, a value goes trimmed', async () => {
    const p = page('https://h.example/pair', [{ status: 200 }])
    expect(p.$('code').tagName).toBe('INPUT')
    expect(p.window.document.activeElement).toBe(p.$('code'))
    await p.submit()
    expect(p.posts).toHaveLength(0)
    p.$('code').value = ' abcde-fghij '
    await p.submit()
    expect(p.posts[0]).toMatchObject({ code: 'abcde-fghij', kind: 'session' })
  })

  it('a rate limit names the wait in minutes', async () => {
    const p = page('https://h.example/pair#ABCDE-FGHIJ', [{ status: 429, body: { error: 'too many failed attempts' }, retryAfter: '61' }])
    await p.submit()
    expect(p.$('line').textContent).toBe('Too many tries. Try again in 2 min.')
    expect(p.$('go').disabled).toBe(false)
  })

  it('a host out of reach says so and gives the button back', async () => {
    const p = page('https://h.example/pair#ABCDE-FGHIJ', ['offline'])
    await p.submit()
    expect(p.$('line').textContent).toBe("Couldn't reach this host.")
    expect(p.$('go').disabled).toBe(false)
  })

  it('a bot link is redeemed as a key, shown once with Copy', async () => {
    const p = page('https://h.example/pair#BOTCD-EFGHI', [
      { status: 400, body: { error: SESSION_NEEDS_CLIENT } },
      { status: 200, body: { key: 'tc_abc.secret', name: 'Claude bot' } }
    ])
    await p.submit()
    expect(p.posts).toEqual([
      { code: 'BOTCD-EFGHI', kind: 'session', name: expect.any(String) },
      { code: 'BOTCD-EFGHI', kind: 'key' }
    ])
    expect(p.$('title').textContent).toBe('Claude bot')
    expect(p.$('key').textContent).toBe('tc_abc.secret')
    expect(p.$('f')).toBeNull()
    expect(p.$('line').textContent).toBe('Shown once.')
    expect(p.window.document.body.innerHTML.match(/tc_abc\.secret/g)).toHaveLength(1)
    p.$('copy').click()
    await new Promise((r) => setTimeout(r, 0))
    expect(p.writeText).toHaveBeenCalledWith('tc_abc.secret')
    expect(p.$('copy').textContent).toBe('Copied')
  })

  it('arriving signed out says so before anything is pressed', () => {
    const p = page('https://h.example/pair?signed-out', [])
    expect(p.$('line').textContent).toBe('Signed out.')
    expect(p.$('line').className).toBe('')
  })
})
