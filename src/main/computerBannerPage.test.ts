import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { BANNER_TOKENS, computerBannerPage } from './computerBannerPage'

/** Same token parser as remote/pairPage.test.ts, including var aliases. */
function appTokens() {
  const css = readFileSync(join(__dirname, '../renderer/src/index.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    ''
  )
  const dark: Record<string, string> = {},
    light: Record<string, string> = {}
  for (const block of css.matchAll(/(:root|@theme|html\.theme-light)\s*\{([^}]*)\}/g)) {
    const into = block[1] === 'html.theme-light' ? light : dark
    for (const decl of block[2].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g))
      into[decl[1]] = decl[2].replace(/\s+/g, ' ').trim()
  }
  const resolve = (table: Record<string, string>, value: string): string =>
    value.replace(/^var\(--([\w-]+)\)$/, (_m, name: string) => resolve(table, table[name] ?? ''))
  const all = { ...dark, ...light }
  return {
    dark: Object.fromEntries(Object.entries(dark).map(([k, v]) => [k, resolve(dark, v)])),
    light: Object.fromEntries(Object.entries(all).map(([k, v]) => [k, resolve(all, v)]))
  }
}

describe('computer banner page', () => {
  it('holds colours, fonts, durations and curves equal to index.css in both themes', () => {
    const app = appTokens()
    for (const mode of ['dark', 'light'] as const)
      for (const [name, value] of Object.entries(BANNER_TOKENS[mode]))
        expect([name, value]).toEqual([name, app[mode][name]])
    for (const [name, value] of Object.entries(BANNER_TOKENS.shared)) {
      expect([name, value]).toEqual([name, app.dark[name]])
      expect(app.light[name]).toBe(value)
    }
    // Tailwind's default type scale has no 13px/11px tokens: these mirror DESIGN.md's scale.
    const design = readFileSync(join(__dirname, '../../docs/DESIGN.md'), 'utf8')
    expect(design).toContain('| 13px |')
    expect(design).toContain('| 11px |')
    expect(BANNER_TOKENS.type).toEqual({ body: '13px', key: '11px' })
  })
  it('has one passive pill with the watch-only key cap and words', () => {
    const dom = new JSDOM(computerBannerPage()),
      doc = dom.window.document
    expect(doc.querySelector('#pill > span')?.textContent).toBe('TempCode is using your Mac')
    expect(doc.querySelector('kbd')?.textContent).toBe('Esc')
    expect(doc.querySelector('#stop')?.textContent).toBe('to stop')
    expect(doc.querySelectorAll('script, button, input')).toHaveLength(0)
    expect(doc.documentElement.className).toBe('hidden')
    expect(computerBannerPage()).toContain('html.esc #escape')
    expect(computerBannerPage()).toContain('gap: 8px')
    dom.window.close()
  })
  it('animates opacity alone, uses the app fades, and draws no shadow or glow', () => {
    const html = computerBannerPage()
    expect(html).toContain('@starting-style')
    expect(html).toContain('prefers-reduced-motion: reduce')
    const transitions = [...html.matchAll(/transition:\s*([^;]+);/g)].map((m) => m[1])
    expect(transitions).toEqual([
      'opacity var(--dur-base) var(--ease-out)',
      'opacity var(--dur-fast) var(--ease-exit)'
    ])
    expect(html).not.toMatch(/box-shadow|text-shadow|filter:|transform:|animation:/)
    expect(html).toContain('height: 32px')
    expect(html).toContain('border-radius: 9999px')
  })
})
