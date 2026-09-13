// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clockForTest } from '../lib/turnClock'
import { mountProbe, Probe } from '../test/renderProbe'
import { TabIndicator, type TabThread } from './TabIndicator'

const thread = (over: Partial<TabThread> = {}): TabThread => ({
  type: 'chat',
  status: 'idle',
  since: Date.now() - 10_000,
  ...over,
})

describe('TabIndicator clock', () => {
  // Fake timers drive the shared interval and move Date.now() with it.
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('an idle tab never subscribes to the second hand', () => {
    const probe = mountProbe(
      <Probe id="idle">
        <TabIndicator thread={thread({ status: 'waiting' })} />
      </Probe>,
    )
    expect(clockForTest.listeners()).toBe(0)
    probe.act(() => vi.advanceTimersByTime(2000))
    expect(probe.renders('idle')).toBe(1)
    probe.unmount()
  })

  it('a working tab ticks alone and lets go when it settles', () => {
    const probe = mountProbe(
      <>
        <Probe id="working">
          <TabIndicator thread={thread({ status: 'running', activity: 'Reading files' })} />
        </Probe>
        <Probe id="idle">
          <TabIndicator thread={thread()} />
        </Probe>
      </>,
    )
    expect(clockForTest.listeners()).toBe(1)
    // Subscribing refreshes the clock, so the mount may settle with one extra commit.
    const settled = probe.renders('working')
    probe.act(() => vi.advanceTimersByTime(1000))
    probe.act(() => vi.advanceTimersByTime(1000))
    expect(probe.renders('working') - settled).toBe(2)
    expect(probe.renders('idle')).toBe(1)
    expect(probe.container.textContent).toContain('Reading')

    probe.rerender(
      <>
        <Probe id="working">
          <TabIndicator thread={thread({ status: 'idle' })} />
        </Probe>
        <Probe id="idle">
          <TabIndicator thread={thread()} />
        </Probe>
      </>,
    )
    expect(clockForTest.listeners()).toBe(0)
    probe.unmount()
  })
})
