import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { HeadroomLine } from './HeadroomLine'

const now = 1_800_000_000_000

afterEach(cleanup)

describe('HeadroomLine', () => {
  it('draws the fill as what is left, with the refill on hover and nothing animated', () => {
    const { container } = render(<HeadroomLine headroom={{ room: 0.4, ratePerMin: 2, seenAt: now, resetsAt: now + 120_000 }} now={now} />)
    const bar = screen.getByRole('progressbar', { name: 'Headroom: 40% left' })
    expect(bar.getAttribute('aria-valuenow')).toBe('40')
    const fill = bar.firstElementChild as HTMLElement
    expect(fill.style.width).toBe('40%')
    expect(fill.className).not.toMatch(/transition|animate/)
    expect(container.firstElementChild?.getAttribute('title')).toMatch(/^Refills .* \(in 2m\)\n2 answers in the last minute, every host$/)
    expect(container.firstElementChild?.getAttribute('data-headroom')).toBe('ok')
  })
  it('a throttled account reads rate limited with the time left', () => {
    const { container } = render(<HeadroomLine headroom={{ room: 0.9, ratePerMin: 0, seenAt: now, throttledUntil: now + 45_000 }} now={now} />)
    expect(screen.getByText('rate limited · under a minute')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0')
    expect(container.firstElementChild?.getAttribute('data-headroom')).toBe('limited')
  })
  it('an account no host has heard from says so', () => {
    render(<HeadroomLine headroom={undefined} now={now} />)
    expect(screen.getByText('no answer yet')).toBeTruthy()
  })
})
