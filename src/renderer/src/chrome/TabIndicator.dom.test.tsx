// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { threadStatus } from '../lib/threadStripModel'
import { ThreadStatusMark } from './TabIndicator'


afterEach(cleanup)

describe('ThreadStatusMark', () => {
  it('says the word, the detail and the tally, separated by margin only', () => {
    const { container } = render(
      <ThreadStatusMark status={threadStatus({ status: 'running', activity: 'Running bun', tasks: { done: 3, total: 7 } })} />,
    )
    expect(container.textContent).toBe('WorkingRunning bun3/7')
    expect(container.textContent).not.toMatch(/[·|•]/)
    expect(container.querySelector('[data-slot="status-detail"] span')?.className).toBe('ms-1')
  })

  it('draws a tally alone without a margin, and only the word with neither', () => {
    const tally = render(<ThreadStatusMark status={{ state: 'working', detail: null, tally: '1/2' }} />)
    expect(tally.container.textContent).toBe('Working1/2')
    expect(tally.container.querySelector('[data-slot="status-detail"] span')?.className).toBe('')
    cleanup()
    const bare = render(<ThreadStatusMark status={{ state: 'paused', detail: null, tally: null }} />)
    expect(bare.container.textContent).toBe('Paused')
    expect(bare.container.querySelector('[data-slot="status-detail"]')).toBeNull()
  })
})
