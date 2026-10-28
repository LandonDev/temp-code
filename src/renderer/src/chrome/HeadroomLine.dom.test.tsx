import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { tooltipChunk, warmTooltips } from '../components/ui/tooltip'
import { HeadroomLine } from './HeadroomLine'

const now = 1_800_000_000_000

afterEach(cleanup)

describe('HeadroomLine', () => {
  it('draws the fill as what is left on the shared Progress, with no legacy classes', () => {
    const { container } = render(<HeadroomLine headroom={{ room: 0.4, ratePerMin: 2, seenAt: now, resetsAt: now + 120_000 }} now={now} />)
    const bar = screen.getByRole('progressbar', { name: 'Headroom: 40% left' })
    expect(bar.getAttribute('aria-valuenow')).toBe('40')
    expect(bar.closest('[data-slot="progress"]')?.getAttribute('data-fill')).toBe('muted')
    const line = container.querySelector('[data-headroom]') as HTMLElement
    expect(line.getAttribute('data-headroom')).toBe('ok')
    expect(line.getAttribute('title')).toBeNull()
    expect(container.innerHTML).not.toMatch(/content\//)
  })
  it('shows the refill lines in a tooltip on hover', async () => {
    await act(async () => {
      warmTooltips()
      await tooltipChunk.load()
    })
    const { container } = render(<HeadroomLine headroom={{ room: 0.4, ratePerMin: 2, seenAt: now, resetsAt: now + 120_000 }} now={now} />)
    const line = container.querySelector('[data-headroom]') as HTMLElement
    fireEvent.pointerEnter(line)
    fireEvent.mouseEnter(line)
    fireEvent.focus(line)
    await waitFor(() => expect(screen.getByText('2 answers in the last minute, every host')).toBeTruthy(), { timeout: 2000 })
    expect(screen.getByText('Refills in 2m')).toBeTruthy()
  })
  it('a throttled account reads Limited and the time left in the warning tone', () => {
    const { container } = render(<HeadroomLine headroom={{ room: 0.9, ratePerMin: 0, seenAt: now, throttledUntil: now + 45_000 }} now={now} />)
    expect(screen.getByText('Limited').parentElement?.className).toContain('text-warning')
    expect(screen.getByText('under a minute')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0')
    expect(screen.getByRole('progressbar').getAttribute('aria-label')).toBe('Headroom: Limited for under a minute')
    expect(container.querySelector('[data-headroom]')?.getAttribute('data-headroom')).toBe('limited')
  })
  it('an account no host has heard from says so', () => {
    render(<HeadroomLine headroom={undefined} now={now} />)
    expect(screen.getByText('No answer yet')).toBeTruthy()
  })
})
