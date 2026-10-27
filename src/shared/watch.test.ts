import { describe, expect, it } from 'vitest'
import type { BackgroundTask, BackgroundWork } from './events'
import { STALE_WATCH_MS, isStaleWatch, watchPhrase, watchSubject } from './watch'

const task = (kind: BackgroundTask['kind'], id: string = kind): BackgroundTask => ({ id, label: id, kind, startedAt: 0 })
const bg = (over: Partial<BackgroundWork>): BackgroundWork => ({
  tasks: [],
  agents: [],
  batch: null,
  watchingSince: null,
  ...over
})

describe('watchPhrase', () => {
  it('is empty with nothing to wait on', () => {
    expect(watchPhrase(null)).toBe('')
    expect(watchPhrase(bg({}))).toBe('')
    expect(watchPhrase(bg({ batch: { out: 0, total: 3 } }))).toBe('')
  })

  it('counts each part, singular and plural', () => {
    expect(watchPhrase(bg({ batch: { out: 1, total: 3 } }))).toBe('a batch thread')
    expect(watchPhrase(bg({ batch: { out: 4, total: 7 } }))).toBe('4 batch threads')
    expect(watchPhrase(bg({ agents: ['a'] }))).toBe('a subagent')
    expect(watchPhrase(bg({ agents: ['a', 'b', 'c'] }))).toBe('3 subagents')
    expect(watchPhrase(bg({ tasks: [task('shell')] }))).toBe('a command')
    expect(watchPhrase(bg({ tasks: [task('shell', 'a'), task('shell', 'b')] }))).toBe('2 commands')
    expect(watchPhrase(bg({ tasks: [task('monitor')] }))).toBe('a monitor')
    expect(watchPhrase(bg({ tasks: [task('agent')] }))).toBe('a background agent')
    expect(watchPhrase(bg({ tasks: [task('workflow')] }))).toBe('a workflow')
    expect(watchPhrase(bg({ tasks: [task('cron')] }))).toBe('a wake-up')
    expect(watchPhrase(bg({ tasks: [task('other')] }))).toBe('a background task')
  })

  it('orders batch, subagents, then the task kinds', () => {
    const all = bg({
      batch: { out: 2, total: 5 },
      agents: ['x', 'y', 'z'],
      tasks: [task('other'), task('cron'), task('monitor'), task('shell'), task('workflow'), task('agent')]
    })
    expect(watchPhrase(all)).toBe(
      '2 batch threads, 3 subagents, a command, a monitor, a background agent, a workflow, a wake-up, a background task'
    )
    expect(watchPhrase(bg({ agents: ['a', 'b', 'c'], tasks: [task('monitor')] }))).toBe('3 subagents, a monitor')
  })
})

describe('isStaleWatch', () => {
  const now = 10 * STALE_WATCH_MS
  it('is true only for a watching thread past the threshold', () => {
    const old = bg({ watchingSince: now - STALE_WATCH_MS - 1 })
    expect(isStaleWatch({ status: 'watching', background: old }, now)).toBe(true)
    expect(isStaleWatch({ status: 'watching', background: bg({ watchingSince: now - STALE_WATCH_MS }) }, now)).toBe(false)
    expect(isStaleWatch({ status: 'idle', background: old }, now)).toBe(false)
    expect(isStaleWatch({ status: 'watching', background: bg({}) }, now)).toBe(false)
    expect(isStaleWatch({ status: 'watching', background: null }, now)).toBe(false)
  })

  it("is never true while live subagents or a master's batch carry the wait", () => {
    const since = now - STALE_WATCH_MS - 1
    const tasks = [task('monitor')]
    expect(isStaleWatch({ status: 'watching', background: bg({ watchingSince: since, tasks, agents: ['c'] }) }, now)).toBe(false)
    expect(isStaleWatch({ status: 'watching', background: bg({ watchingSince: since, tasks, batch: { out: 1, total: 2 } }) }, now)).toBe(false)
    expect(isStaleWatch({ status: 'watching', background: bg({ watchingSince: since, batch: { out: 0, total: 2 } }) }, now)).toBe(false)
  })
})

describe('watchSubject', () => {
  it('is the phrase, else the batch steps, else background work', () => {
    expect(watchSubject(bg({ agents: ['a'] }))).toBe('a subagent')
    expect(watchSubject(bg({ batch: { out: 0, total: 3 } }))).toBe("the batch's steps")
    expect(watchSubject(bg({}))).toBe('background work')
    expect(watchSubject(null)).toBe('background work')
  })
})
