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
    expect(button.textContent).toBe('Project rules · 212 words')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(queryByText(/Never touch prod/)).toBeNull()
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('pre')?.textContent).toBe('- Work in a worktree.\n- Never touch prod.')
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
    expect(button.textContent).toBe('Project rules · 1 word')
    fireEvent.click(button)
    expect(onBubble).not.toHaveBeenCalled()
  })
})
