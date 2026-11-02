// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(cleanup)
import { PreambleRow } from './PreambleRow'

describe('PreambleRow', () => {
  it('shows one muted line with the count and opens the text on click', () => {
    const { container, getByRole, queryByText } = render(
      <PreambleRow text={'- Work in a worktree.\n- Never touch prod.'} words={212} />
    )
    const button = getByRole('button')
    expect(button.textContent).toBe('Project rules212 words')
    expect(button.textContent).not.toContain('·')
    // A fixed 24px trigger whose colour eases on hover; its chevron turns with the fold.
    for (const c of ['h-6', 'px-2', 'transition-colors', 'duration-(--dur-fast)', 'ease-(--ease-out)', 'motion-reduce:transition-none'])
      expect(button.className).toContain(c)
    expect(button.className).not.toContain('py-1')
    const chevron = button.querySelector('svg')!.getAttribute('class')!
    expect(chevron).toContain('duration-(--dur-base)')
    expect(chevron).not.toContain('rotate-90')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(queryByText(/Never touch prod/)).toBeNull()
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(button.querySelector('svg')!.getAttribute('class')).toContain('rotate-90')
    expect(container.querySelector('pre')?.textContent).toBe('- Work in a worktree.\n- Never touch prod.')
    expect(container.querySelector('[data-slot="collapsible-content"]')).not.toBeNull()
    fireEvent.click(button)
    expect(queryByText(/Never touch prod/)).toBeNull()
  })
  it('singular for one word, and the click never reaches the bubble', () => {
    const onBubble = vi.fn()
    const { getByRole } = render(
      <div onClick={onBubble}>
        <PreambleRow text="go" words={1} />
      </div>
    )
    const button = getByRole('button')
    expect(button.textContent).toBe('Project rules1 word')
    fireEvent.click(button)
    expect(onBubble).not.toHaveBeenCalled()
  })
})
