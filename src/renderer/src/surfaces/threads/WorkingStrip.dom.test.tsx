// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
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
  it('says Queued with no clock and no buttons', () => {
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
})
