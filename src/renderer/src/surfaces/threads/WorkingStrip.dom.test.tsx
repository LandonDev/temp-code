// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

const { killBackground } = vi.hoisted(() => ({ killBackground: vi.fn(() => Promise.resolve()) }))
vi.mock('../../lib/tcserver/commands', () => ({ killBackground }))
import { newSession, type Block, type Session } from '../../lib/session'
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
    expect(probe.container.textContent).toBe('Queued3rd in lineStart now')
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

describe('WorkingStrip: a working thread', () => {
  it('says what it does, the tally and the elapsed time, with no flavour word', () => {
    const probe = mountProbe(
      <Probe id="strip">
        <WorkingStrip
          session={session({
            status: 'running',
            activity: 'Running bun',
            tasks: { done: 3, total: 7 } as Session['tasks'],
            busySince: Date.now() - 92_000,
          })}
          onStop={() => {}}
          onResume={() => {}}
        />
      </Probe>,
    )
    const text = probe.container.textContent ?? ''
    expect(text).toMatch(/^Workingrunning bun3\/71m 3\ds$/)
    expect(text).not.toMatch(/Thinking|Percolating|·/)
    expect(probe.container.querySelectorAll('button')).toHaveLength(0)
    probe.unmount()
  })

  it('says starting before the host names an activity', () => {
    const probe = mountProbe(
      <Probe id="strip">
        <WorkingStrip session={session({ status: 'starting' })} onStop={() => {}} onResume={() => {}} />
      </Probe>,
    )
    expect(probe.container.textContent).toBe('Workingstarting')
    probe.unmount()
  })
})

describe('WorkingStrip: a thread that needs you', () => {
  const approvalBlock = (requestId: string, decided = false): Block =>
    ({
      id: `b-${requestId}`,
      role: 'tool',
      kind: 'tool',
      tool: 'Bash',
      title: 'Bash',
      text: '',
      input: { command: 'bun test' },
      approval: { requestId, decided },
    }) as unknown as Block

  it('names the approval, and Deny and Allow decide the pending one', async () => {
    const onApproval = vi.fn()
    const probe = mountProbe(
      <Probe id="strip">
        <WorkingStrip
          session={session({ status: 'waiting', blocks: [approvalBlock('r1', true), approvalBlock('r2')] })}
          onStop={() => {}}
          onResume={() => {}}
          onApproval={onApproval}
        />
      </Probe>,
    )
    expect(probe.container.textContent).toMatch(/^Needs youapprove \S/)
    const buttons = [...probe.container.querySelectorAll('button')]
    expect(buttons.map((b) => b.textContent)).toEqual(['Deny', 'Allow'])
    await probe.act(async () => buttons[0]!.click())
    await probe.act(async () => buttons[1]!.click())
    expect(onApproval.mock.calls).toEqual([
      ['r2', 'deny'],
      ['r2', 'allow'],
    ])
    probe.unmount()
  })

  it('says a question waits, and leaves the choice to its card', () => {
    const question = {
      id: 'q',
      role: 'assistant',
      kind: 'text',
      text: '',
      question: { sessionId: 's', requestId: 'q1', questions: [] },
    } as unknown as Block
    const probe = mountProbe(
      <Probe id="strip">
        <WorkingStrip session={session({ status: 'waiting', blocks: [question] })} onStop={() => {}} onResume={() => {}} onApproval={() => {}} />
      </Probe>,
    )
    expect(probe.container.textContent).toBe('Needs youanswer a question')
    expect(probe.container.querySelectorAll('button')).toHaveLength(0)
    probe.unmount()
  })
})

describe('WorkingStrip: a paused run', () => {
  it('keeps the frozen time, offers Stop and Continue, and sits in no box', async () => {
    const onStop = vi.fn()
    const onResume = vi.fn(() => Promise.resolve())
    const probe = mountProbe(
      <Probe id="strip">
        <WorkingStrip session={session({ status: 'paused', frozenActiveElapsed: 250_000 })} onStop={onStop} onResume={onResume} />
      </Probe>,
    )
    expect(probe.container.textContent).toBe('Paused4m 10sStopContinue')
    expect(probe.container.innerHTML).not.toMatch(/bg-warning|border-warning|rounded-lg/)
    const [stop, cont] = [...probe.container.querySelectorAll('button')]
    await probe.act(async () => stop!.click())
    await probe.act(async () => cont!.click())
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(onResume).toHaveBeenCalledTimes(1)
    probe.unmount()
  })
})

describe('WorkingStrip: a root whose tree holds a paused thread', () => {
  it('reads Paused with Stop and Continue, idle or running, and no time of its own', () => {
    for (const status of ['idle', 'running'] as const) {
      const probe = mountProbe(
        <Probe id="strip">
          <WorkingStrip session={session({ status, treeHasPaused: true, activity: 'Running bun' })} onStop={() => {}} onResume={() => {}} />
        </Probe>,
      )
      expect(probe.container.textContent).toBe('PausedStopContinue')
      probe.unmount()
    }
  })

  it('leaves a subagent its own row: a waiting child keeps Allow and Deny', () => {
    const block = { id: 'b', role: 'tool', kind: 'tool', text: '', approval: { requestId: 'r', decided: false } } as unknown as Block
    const probe = mountProbe(
      <Probe id="strip">
        <WorkingStrip
          session={session({ status: 'waiting', parentId: 'root', treeHasPaused: true, blocks: [block] })}
          onStop={() => {}}
          onResume={() => {}}
          onApproval={() => {}}
        />
      </Probe>,
    )
    expect([...probe.container.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Deny', 'Allow'])
    probe.unmount()
  })
})
