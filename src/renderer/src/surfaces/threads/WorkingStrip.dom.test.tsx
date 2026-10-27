// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

const { killBackground } = vi.hoisted(() => ({ killBackground: vi.fn(() => Promise.resolve()) }))
vi.mock('../../lib/tcserver/commands', () => ({ killBackground }))
import { newSession, type Session } from '../../lib/session'
import { mountProbe, Probe } from '../../test/renderProbe'
import { WorkingStrip } from './WorkingStrip'

const session = (over: Partial<Session>): Session => ({
  ...newSession('env-local'),
  ...over,
})

describe('WorkingStrip: a stopped run', () => {
  it('says the harness is gone, keeps the frozen time, and Resume calls back', async () => {
    const onResume = vi.fn(() => Promise.resolve())
    const onStop = vi.fn()
    const probe = mountProbe(
      <Probe id="strip">
        <WorkingStrip
          session={session({ status: 'stopped', frozenActiveElapsed: 95_000 })}
          onStop={onStop}
          onResume={onResume}
        />
      </Probe>,
    )
    const text = probe.container.textContent ?? ''
    expect(text).toContain('Stopped')
    expect(text).toContain('the harness is gone')
    expect(text).toContain('1m 35s')
    // Shown, not faded out like the idle slot.
    expect(probe.container.querySelector('.opacity-100')).not.toBeNull()
    const buttons = [...probe.container.querySelectorAll('button')]
    expect(buttons.map((b) => b.textContent)).toEqual(['Resume'])
    await probe.act(async () => {
      buttons[0]!.click()
    })
    expect(onResume).toHaveBeenCalledTimes(1)
    expect(onStop).not.toHaveBeenCalled()
    probe.unmount()
  })

  it('an idle run shows nothing and offers no Resume', () => {
    const probe = mountProbe(
      <Probe id="strip">
        <WorkingStrip session={session({ status: 'idle' })} onStop={() => {}} onResume={() => {}} />
      </Probe>,
    )
    expect(probe.container.querySelector('.opacity-0')).not.toBeNull()
    expect(probe.container.querySelectorAll('button')).toHaveLength(0)
    expect(probe.container.textContent).not.toContain('Stopped')
    probe.unmount()
  })
})

describe('WorkingStrip: a queued thread', () => {
  it('says Queued with no clock, and no button without a starter', () => {
    const probe = mountProbe(
      <Probe id="strip">
        <WorkingStrip session={session({ status: 'queued' })} onStop={() => {}} onResume={() => {}} />
      </Probe>,
    )
    expect(probe.container.textContent).toBe('Queued')
    expect(probe.container.querySelector('.opacity-100')).not.toBeNull()
    expect(probe.container.querySelectorAll('button')).toHaveLength(0)
    probe.unmount()
  })
  it("reads the host's line and Start now calls back", async () => {
    const onStart = vi.fn(() => Promise.resolve())
    const probe = mountProbe(
      <Probe id="strip">
        <WorkingStrip
          session={session({ status: 'queued', activity: 'Queued · 3rd in line' })}
          onStop={() => {}}
          onResume={() => {}}
          onStart={onStart}
        />
      </Probe>,
    )
    expect(probe.container.textContent).toContain('Queued · 3rd in line')
    const buttons = probe.container.querySelectorAll('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].textContent).toBe('Start now')
    buttons[0].click()
    expect(onStart).toHaveBeenCalledTimes(1)
    probe.unmount()
  })
})

describe('WorkingStrip: a watching thread', () => {
  const watching = (since: number) =>
    session({
      status: 'watching',
      background: {
        tasks: [{ id: 'm1', label: 'tail the log', kind: 'monitor', startedAt: since }],
        agents: ['c1', 'c2', 'c3'],
        batch: null,
        watchingSince: since,
      },
    })

  it('says what it watches with its age, and offers no Stop all while fresh', async () => {
    const onOpenActivity = vi.fn()
    const probe = mountProbe(
      <Probe id="strip">
        <WorkingStrip session={watching(Date.now() - 5 * 60_000)} onStop={() => {}} onResume={() => {}} onOpenActivity={onOpenActivity} />
      </Probe>,
    )
    const text = probe.container.textContent ?? ''
    expect(text).toContain('Watching')
    expect(text).toContain('3 subagents, a monitor')
    expect(text).toContain('5m')
    expect(probe.container.querySelector('.text-warning')).toBeNull()
    const buttons = [...probe.container.querySelectorAll('button')]
    expect(buttons.map((b) => b.textContent)).toEqual(['Watching3 subagents, a monitor'])
    await probe.act(async () => {
      buttons[0]!.click()
    })
    expect(onOpenActivity).toHaveBeenCalledTimes(1)
    probe.unmount()
  })

  it('turns the age amber past 30 minutes and Stop all stops the background work', async () => {
    const stale = watching(Date.now() - 45 * 60_000)
    const probe = mountProbe(
      <Probe id="strip">
        <WorkingStrip session={stale} onStop={() => {}} onResume={() => {}} />
      </Probe>,
    )
    const age = probe.container.querySelector('.text-warning')
    expect(age?.textContent).toBe('45m')
    const stop = [...probe.container.querySelectorAll('button')].find((b) => b.textContent === 'Stop all')
    expect(stop).toBeDefined()
    await probe.act(async () => {
      stop!.click()
    })
    expect(killBackground).toHaveBeenCalledWith(stale.id)
    probe.unmount()
  })
})
