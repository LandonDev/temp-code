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

describe('TabIndicator plan ready vs watching', () => {
  const text = (over: Partial<TabThread>) => {
    const probe = mountProbe(<TabIndicator thread={thread(over)} />)
    const out = probe.container.textContent
    const title = probe.container.querySelector('[title]')?.getAttribute('title') ?? null
    probe.unmount()
    return { out, title }
  }

  it('a planning thread with a written plan reads Plan ready even while it watches background work', () => {
    const { out, title } = text({
      type: 'planning',
      status: 'watching',
      planReady: true,
      activity: 'Wait in the background for the delivery note',
    })
    expect(out).toBe('Plan ready')
    expect(title).toBe('Wait in the background for the delivery note')
  })

  it('a watching planning thread with no plan yet reads Watching', () => {
    expect(text({ type: 'planning', status: 'watching' }).out).toBe('Watching')
  })

  it('a watching non-planning thread reads Watching', () => {
    expect(text({ type: 'implementation', status: 'watching' }).out).toBe('Watching')
  })

  it('running, paused, waiting and failed still outrank a written plan', () => {
    expect(text({ type: 'planning', status: 'running', planReady: true }).out).not.toContain('Plan ready')
    expect(text({ type: 'planning', status: 'paused', planReady: true }).out).toContain('Paused')
    expect(text({ type: 'planning', status: 'waiting', planReady: true }).out).toBe('Needs you')
    expect(text({ type: 'planning', status: 'error', planReady: true }).out).toBe('Failed')
  })
})
