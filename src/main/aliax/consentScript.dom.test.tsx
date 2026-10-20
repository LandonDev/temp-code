import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { consentScript } from './consentScript'

/** The script as the mint window runs it: in the page, with its own timers. */
const run = (script: string): unknown => new Function(`return ${script}`)()
const button = (label: string, clicks: string[]): HTMLButtonElement => {
  const b = document.createElement('button')
  b.textContent = label
  b.addEventListener('click', () => clicks.push(label))
  document.body.appendChild(b)
  return b
}

describe('consentScript', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = ''
    delete (window as unknown as { __tcConsent?: unknown }).__tcConsent
  })
  afterEach(() => vi.useRealTimers())

  it('waits for the approve button the page renders after load and clicks it once; a cancel button is never clicked', () => {
    const clicks: string[] = []
    button('Cancel', clicks)
    expect(run(consentScript())).toBe('armed')
    setTimeout(() => button('Authorize', clicks), 900)
    vi.advanceTimersByTime(800)
    expect(clicks).toEqual([])
    vi.advanceTimersByTime(400)
    expect(clicks).toEqual(['Authorize'])
    // Once per page: a second arming does nothing, and the interval is gone.
    expect(run(consentScript())).toBe('armed')
    vi.advanceTimersByTime(5_000)
    expect(clicks).toEqual(['Authorize'])
  })

  it('clicks at once when the button is already there, in any of its spellings', () => {
    const clicks: string[] = []
    button('Allow', clicks)
    expect(run(consentScript())).toBe('clicked')
    expect(clicks).toEqual(['Allow'])
  })

  it('gives up after the wait: a button rendered later is left alone', () => {
    const clicks: string[] = []
    expect(run(consentScript())).toBe('armed')
    vi.advanceTimersByTime(41_000)
    button('Authorize', clicks)
    vi.advanceTimersByTime(2_000)
    expect(clicks).toEqual([])
  })

  it('a disabled approve button does not count: the page enables it once its own check answers, and only then is it clicked', () => {
    const clicks: string[] = []
    const b = button('Authorize', clicks)
    b.disabled = true
    expect(run(consentScript())).toBe('armed')
    vi.advanceTimersByTime(3_000)
    expect(clicks).toEqual([])
    b.disabled = false
    vi.advanceTimersByTime(300)
    expect(clicks).toEqual(['Authorize'])
    vi.advanceTimersByTime(3_000)
    expect(clicks).toEqual(['Authorize'])
  })

  it('the test seam clicks the named element, whatever its label', () => {
    const clicks: string[] = []
    button('Authorize', clicks)
    const b = button('Go', clicks)
    b.id = 'approve'
    expect(run(consentScript('#approve'))).toBe('clicked')
    expect(clicks).toEqual(['Go'])
  })
})
