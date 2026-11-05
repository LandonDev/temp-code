// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { newSession, type Block, type Session } from '../../lib/session'
import { emptyThread } from '../../lib/tcserver/todos'
import { mountProbe, Probe } from '../../test/renderProbe'
import { WorkingStrip } from './WorkingStrip'

const session = (over: Partial<Session>): Session => ({
  ...newSession('env-local'),
  ...over,
})

type Mounted = ReturnType<typeof mountProbe>

/** The visible row, without the screen reader's word. */
const row = (probe: Mounted): HTMLElement => probe.container.querySelector<HTMLElement>('.h-full')!
const rowText = (probe: Mounted): string => row(probe).textContent ?? ''
const buttons = (probe: Mounted): HTMLButtonElement[] => [...probe.container.querySelectorAll('button')]

const mount = (s: Session, props: Partial<Parameters<typeof WorkingStrip>[0]> = {}): Mounted =>
  mountProbe(
    <Probe id="strip">
      <WorkingStrip session={s} onStop={() => {}} onResume={() => {}} {...props} />
    </Probe>,
  )

const approvalBlock = (requestId: string, decided = false): Block =>
  ({
    id: `b-${requestId}`,
    role: 'tool',
    kind: 'tool',
    tool: { name: 'Bash', kind: 'execute', title: 'Bash', input: { command: 'bun test' } },
    title: 'Bash',
    text: '',
    approval: { requestId, decided },
  }) as unknown as Block

describe('WorkingStrip: the timer while a turn is open', () => {
  it('a working thread shows only the time and Stop: no mark, activity or tally', () => {
    const probe = mount(
      session({
        status: 'running',
        activity: 'Running bun',
        tasks: { done: 3, total: 7 } as Session['tasks'],
        busySince: Date.now() - 92_000,
      }),
    )
    expect(rowText(probe)).toMatch(/^1m 3\dsStop$/)
    expect(row(probe).querySelector('svg')).toBeNull()
    expect(probe.container.querySelector('.opacity-100')).not.toBeNull()
    probe.unmount()
  })

  it('an open compaction leaves the turn timer as is: the time from the turn start, no compaction words', () => {
    const compaction = {
      id: 'c',
      role: 'system',
      text: 'Compacting context',
      compaction: { phase: 'start', startedAt: Date.now() - 20_000 },
    } as Block
    const probe = mount(
      session({
        status: 'running',
        activity: 'Compacting context',
        busySince: Date.now() - 92_000,
        blocks: [compaction],
        thread: { ...emptyThread(), compacting: true, compactionId: 'c' },
      }),
    )
    expect(rowText(probe)).toMatch(/^1m 3\dsStop$/)
    expect(probe.container.textContent).not.toMatch(/compact/i)
    probe.unmount()
  })

  it('Stop calls back once and spins while it lands, its word standing over Send', async () => {
    const onStop = vi.fn()
    const probe = mount(session({ status: 'running', busySince: Date.now() - 5_000 }), { onStop })
    const [stop] = buttons(probe)
    expect(buttons(probe).map((b) => b.textContent)).toEqual(['Stop'])
    // The word sits at the end of its reserved width, which holds only the spinner's slot.
    const label = stop!.querySelector<HTMLElement>('[data-slot="busy-label"]')!
    expect(label.dataset.busyText).toBe('Stop')
    expect(label.firstElementChild!.className).toContain('justify-end')
    await probe.act(async () => stop!.click())
    await probe.act(async () => stop!.click())
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(stop!.textContent).toBe('Stop')
    expect(stop!.querySelector('[data-slot="spinner"]')).not.toBeNull()
    expect(stop!.disabled).toBe(true)
    probe.unmount()
  })

  it('a starting thread with no elapsed time shows Stop alone', () => {
    const probe = mount(session({ status: 'starting', busySince: Date.now() }))
    expect(rowText(probe)).toBe('Stop')
    probe.unmount()
  })

  it('a thread waiting on an approval shows the time and Stop, with no Allow, Deny or Needs you', () => {
    const probe = mount(
      session({ status: 'waiting', busySince: Date.now() - 12_000, blocks: [approvalBlock('r1', true), approvalBlock('r2')] }),
    )
    expect(rowText(probe)).toMatch(/^1\dsStop$/)
    expect(rowText(probe)).not.toContain('Needs you')
    expect(buttons(probe).map((b) => b.textContent)).toEqual(['Stop'])
    probe.unmount()
  })

  it('a thread waiting on a question shows the same', () => {
    const question = {
      id: 'q',
      role: 'assistant',
      kind: 'text',
      text: '',
      question: { sessionId: 's', requestId: 'q1', questions: [] },
    } as unknown as Block
    const probe = mount(session({ status: 'waiting', busySince: Date.now() - 12_000, blocks: [question] }))
    expect(rowText(probe)).toMatch(/^1\dsStop$/)
    probe.unmount()
  })

  it('a waiting subagent under a paused tree keeps its own timer', () => {
    const probe = mount(
      session({ status: 'waiting', parentId: 'root', treeHasPaused: true, busySince: Date.now() - 3_000, blocks: [approvalBlock('r')] }),
    )
    expect(rowText(probe)).toMatch(/^\dsStop$/)
    probe.unmount()
  })

  it('the polite live region holds the word, and the time is a timer outside it', () => {
    const probe = mount(session({ status: 'running', busySince: Date.now() - 5_000 }))
    const live = probe.container.querySelector('[aria-live="polite"]')!
    expect(live.textContent).toBe('Working')
    expect(live.className).toContain('sr-only')
    const timer = probe.container.querySelector('[role="timer"]')!
    expect(timer.textContent).toMatch(/^\ds$/)
    expect(live.contains(timer)).toBe(false)
    expect(row(probe).getAttribute('aria-live')).toBeNull()
    probe.unmount()
  })
})

describe('WorkingStrip: a send just made', () => {
  it('shows the timer at once over a failed or stopped row, counting from the click', () => {
    for (const status of ['error', 'stopped'] as const) {
      const probe = mount(session({ status, busy: true, sentAt: Date.now() - 2_000, frozenActiveElapsed: 60_000 }))
      expect(rowText(probe)).toMatch(/^2sStop$/)
      probe.unmount()
    }
  })

  it('a failed row with no send in flight keeps the slot empty', () => {
    const probe = mount(session({ status: 'error', busy: true }))
    expect(probe.container.textContent).toBe('')
    probe.unmount()
  })
})

describe('WorkingStrip: the slot is empty', () => {
  it('for an idle thread', () => {
    const probe = mount(session({ status: 'idle' }))
    expect(probe.container.querySelector('.opacity-0')).not.toBeNull()
    expect(buttons(probe)).toHaveLength(0)
    expect(probe.container.textContent).toBe('')
    probe.unmount()
  })

  it('for a watching thread: the transcript says Watching', () => {
    const since = Date.now() - 45 * 60_000
    const probe = mount(
      session({
        status: 'watching',
        background: { tasks: [{ id: 'm1', label: 'tail the log', kind: 'monitor', startedAt: since }], agents: [], batch: null, watchingSince: since },
      }),
    )
    expect(probe.container.querySelector('.opacity-0')).not.toBeNull()
    expect(probe.container.textContent).toBe('')
    expect(buttons(probe)).toHaveLength(0)
    probe.unmount()
  })

  it('for an idle parent with a live subagent', () => {
    const probe = mount(session({ status: 'idle', background: { tasks: [], agents: ['c1'], watchingSince: null } }))
    expect(probe.container.textContent).toBe('')
    probe.unmount()
  })
})

describe('WorkingStrip: the held rows', () => {
  it('a paused run keeps its frozen time, Stop and Continue, in no box', async () => {
    const onStop = vi.fn()
    const onResume = vi.fn(() => Promise.resolve())
    const probe = mount(session({ status: 'paused', frozenActiveElapsed: 250_000 }), { onStop, onResume })
    expect(rowText(probe)).toBe('Paused4m 10sStopContinue')
    expect(probe.container.innerHTML).not.toMatch(/bg-warning|border-warning|rounded-lg/)
    // The glyph sits in the `+` button's 28px box, on its axis.
    expect(row(probe).querySelector('[data-slot="status-mark"]')!.className).toContain('*:data-[slot=status-glyph]:w-7')
    const [stop, cont] = buttons(probe)
    await probe.act(async () => stop!.click())
    await probe.act(async () => stop!.click())
    await probe.act(async () => cont!.click())
    expect(onStop).toHaveBeenCalledTimes(1)
    // Stop here spins as the timer's does, and takes no second click.
    expect(stop!.querySelector('[data-slot="spinner"]')).not.toBeNull()
    expect(stop!.disabled).toBe(true)
    expect(onResume).toHaveBeenCalledTimes(1)
    probe.unmount()
  })

  it('a root whose tree holds a paused thread reads Paused, idle or running, with no time of its own', () => {
    for (const status of ['idle', 'running'] as const) {
      const probe = mount(session({ status, treeHasPaused: true, activity: 'Running bun' }))
      expect(rowText(probe)).toBe('PausedStopContinue')
      probe.unmount()
    }
  })

  it('a stopped run says the harness is gone, keeps the frozen time, and Resume calls back', async () => {
    const onResume = vi.fn(() => Promise.resolve())
    const onStop = vi.fn()
    const probe = mount(session({ status: 'stopped', frozenActiveElapsed: 95_000 }), { onStop, onResume })
    expect(rowText(probe)).toBe('StoppedThe harness is gone1m 35sResume')
    expect(probe.container.querySelector('[aria-live="polite"]')!.textContent).toBe('Stopped')
    await probe.act(async () => buttons(probe)[0]!.click())
    expect(onResume).toHaveBeenCalledTimes(1)
    expect(onStop).not.toHaveBeenCalled()
    probe.unmount()
  })

  it('a queued thread says Queued with no clock, and no button without a starter', () => {
    const probe = mount(session({ status: 'queued' }))
    expect(rowText(probe)).toBe('Queued')
    expect(buttons(probe)).toHaveLength(0)
    probe.unmount()
  })

  it("a queued thread reads the host's line and Start now calls back", async () => {
    const onStart = vi.fn(() => Promise.resolve())
    const probe = mount(session({ status: 'queued', activity: 'Queued  3rd in line' }), { onStart })
    expect(rowText(probe)).toBe('Queued3rd in lineStart now')
    // A held row's way on is raised, as Continue and Resume are; Stop alone stays ghost.
    expect(buttons(probe)[0]!.getAttribute('data-variant') ?? buttons(probe)[0]!.className).toMatch(/secondary/)
    await probe.act(async () => buttons(probe)[0]!.click())
    expect(onStart).toHaveBeenCalledTimes(1)
    probe.unmount()
  })
})

describe('WorkingStrip: the row shares the box and the line rule', () => {
  it("is inset 6px, the composer row's own, and puts 4px between its facts", () => {
    const probe = mount(session({ status: 'paused', busySince: Date.now() - 60_000, pausedAt: Date.now(), frozenActiveElapsed: 60_000 }))
    const classes = row(probe).className.split(' ')
    expect(classes).toEqual(expect.arrayContaining(['px-1.5', 'gap-1']))
    expect(classes).not.toContain('px-4')
    expect(classes).not.toContain('gap-2')
    probe.unmount()
  })
})

describe('WorkingStrip: the slot empties with a fade', () => {
  const working = session({ status: 'running', busySince: Date.now() - 5_000 })
  const idle = { ...working, status: 'idle' as const, busy: false, busySince: null }
  const strip = (s: Session) => (
    <Probe id="strip">
      <WorkingStrip session={s} onStop={() => {}} onResume={() => {}} />
    </Probe>
  )

  it('keeps the outgoing row, inert, for --dur-fast, then the slot is empty', () => {
    vi.useFakeTimers()
    try {
      const probe = mount(working)
      expect(rowText(probe)).toContain('Stop')
      probe.rerender(strip(idle))
      // Still drawn while it fades, and nothing in it takes a click.
      expect(rowText(probe)).toContain('Stop')
      expect(row(probe).hasAttribute('inert')).toBe(true)
      expect(row(probe).className).toContain('opacity-0')
      vi.advanceTimersByTime(130)
      probe.rerender(strip(idle))
      expect(rowText(probe)).toBe('')
      // The reserved 28px never changes.
      expect(probe.container.firstElementChild?.className).toContain('h-7')
      probe.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('goes at once under reduced motion', () => {
    const original = window.matchMedia
    window.matchMedia = ((query: string) => ({ matches: query.includes('reduce'), media: query })) as typeof window.matchMedia
    try {
      const probe = mount(working)
      probe.rerender(strip(idle))
      expect(rowText(probe)).toBe('')
      probe.unmount()
    } finally {
      window.matchMedia = original
    }
  })
})
