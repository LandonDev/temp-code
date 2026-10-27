// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionStatus } from '../lib/tcserver/types'
import { clockForTest } from '../lib/turnClock'
import { threadStatus } from '../lib/threadStripModel'
import { TabIndicator, ThreadStatusMark, type TabThread } from './TabIndicator'

const thread = (over: Partial<TabThread> = {}): TabThread => ({
  type: 'chat',
  status: 'idle',
  since: Date.now() - 10_000,
  ...over,
})

const mark = (container: HTMLElement) => container.querySelector('[data-slot="status-mark"]')

afterEach(cleanup)

describe('TabIndicator', () => {
  it('never subscribes to the second hand, whatever the state', () => {
    for (const status of ['running', 'starting', 'paused', 'waiting', 'watching', 'queued'] as SessionStatus[]) {
      const { unmount } = render(<TabIndicator thread={thread({ status, activity: 'Reading files' })} />)
      expect(clockForTest.listeners()).toBe(0)
      unmount()
    }
  })

  it('draws the glyph alone, named by its aria-label', () => {
    const cases: [Partial<TabThread>, string, string][] = [
      [{ status: 'running', activity: 'Running bun', tasks: { done: 3, total: 7 } }, 'working', 'Working'],
      [{ status: 'waiting', waitingOn: 'Bash: bun test' }, 'waiting', 'Needs you'],
      [{ status: 'paused', frozenElapsed: 60_000 }, 'paused', 'Paused'],
      [{ status: 'error', failure: 'Usage cap' }, 'failed', 'Failed'],
      [{ status: 'queued', activity: 'Queued · 3rd in line' }, 'queued', 'Queued'],
      [{ status: 'stopped' }, 'stopped', 'Stopped'],
      [{ status: 'watching', activity: 'Waiting on 2 monitors' }, 'watching', 'Watching'],
    ]
    for (const [over, state, word] of cases) {
      const { container, unmount } = render(<TabIndicator thread={thread(over)} />)
      expect(mark(container)?.getAttribute('data-state')).toBe(state)
      expect(mark(container)?.getAttribute('aria-label')).toBe(word)
      // No clock, no verb, no tally, no failure text at the edge.
      expect(container.textContent).toBe('')
      unmount()
    }
  })

  it('draws nothing for idle and done, unread or not', () => {
    for (const status of ['idle', 'done'] as SessionStatus[]) {
      const { container, unmount } = render(<TabIndicator thread={thread({ status, unread: true })} />)
      expect(container.innerHTML).toBe('')
      unmount()
    }
  })

  it('draws the plan-ready glyph for a written plan, even while it watches', () => {
    const { container } = render(<TabIndicator thread={thread({ status: 'watching', planReady: true })} />)
    expect(mark(container)?.getAttribute('data-state')).toBe('plan-ready')
    expect(mark(container)?.getAttribute('aria-label')).toBe('Plan ready')
  })
})

describe('ThreadStatusMark', () => {
  it('says the word, the detail and the tally, separated by margin only', () => {
    const { container } = render(
      <ThreadStatusMark status={threadStatus({ status: 'running', activity: 'Running bun', tasks: { done: 3, total: 7 } })} />,
    )
    expect(container.textContent).toBe('Workingrunning bun3/7')
    expect(container.textContent).not.toMatch(/[·|•]/)
    expect(container.querySelector('[data-slot="status-detail"] span')?.className).toBe('ms-2')
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
