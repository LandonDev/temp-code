import { afterEach, describe, expect, it, vi } from 'vitest'
import { hexOf, oscColors, statusPollAllowed, terminalTheme } from './TerminalView'

// What the tokens compute to in each scheme (index.css), keyed by the expression the probe asks for.
const TOKENS = {
  dark: { 'var(--color-foreground)': 'rgb(231, 232, 234)', 'var(--color-accent)': 'rgb(69, 155, 247)', 'var(--color-background)': 'rgb(20, 21, 22)' },
  light: { 'var(--color-foreground)': 'rgb(21, 22, 24)', 'var(--color-accent)': 'rgb(10, 119, 235)', 'var(--color-background)': 'rgb(255, 255, 255)' }
} as const

function computeTokens(scheme: keyof typeof TOKENS) {
  const real = window.getComputedStyle
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) => {
    const asked = (el as HTMLElement).style.getPropertyValue('color') as keyof (typeof TOKENS)['dark']
    return { ...real(el), color: TOKENS[scheme][asked] ?? '' } as CSSStyleDeclaration
  })
}

afterEach(() => vi.restoreAllMocks())

describe('the terminal chrome reads the tokens', () => {
  it.each(['dark', 'light'] as const)('answers OSC queries with the theme’s text and cursor and the content background (%s)', (scheme) => {
    computeTokens(scheme)
    const light = scheme === 'light'
    const theme = terminalTheme(light)
    const osc = oscColors(light)
    expect(theme.foreground).toBe(TOKENS[scheme]['var(--color-foreground)'])
    expect(osc.fg).toBe(hexOf(theme.foreground, ''))
    expect(osc.cursor).toBe(hexOf(theme.cursor, ''))
    expect(osc.fg).toBe(light ? '#151618' : '#e7e8ea')
    expect(osc.bg).toBe(light ? '#ffffff' : '#141516')
  })

  it('turns rgb and hex into #rrggbb, and anything unreadable into the fallback', () => {
    expect(hexOf('rgb(10, 119, 235)', '#000000')).toBe('#0a77eb')
    expect(hexOf('#ABCDEF', '#000000')).toBe('#abcdef')
    expect(hexOf('', '#123456')).toBe('#123456')
  })
})

describe('the status poll', () => {
  it('polls only for the shown terminal of a shown pane while the document is visible', () => {
    expect(statusPollAllowed(true, true, false)).toBe(true)
    // A parked warm pane is not hidden from the browser: it polls nothing.
    expect(statusPollAllowed(true, false, false)).toBe(false)
    // Another terminal tab of the dock, or a hidden window, polls nothing.
    expect(statusPollAllowed(false, true, false)).toBe(false)
    expect(statusPollAllowed(true, true, true)).toBe(false)
  })
})
