import { describe, expect, it } from 'vitest'
import type { BackgroundTask, BackgroundWork } from './events'
import { STALE_WATCH_MS, bareAgentId, cutAtWord, isStaleWatch, waitLine, waitSubject, watchPhrase, watchSubject } from './watch'

// Unlabelled, so a lone task counts; `labelled` names one in the model's words.
const task = (kind: BackgroundTask['kind'], id: string = kind): BackgroundTask => ({ id, label: '', kind, startedAt: 0 })
const labelled = (label: string, kind: BackgroundTask['kind'] = 'shell'): BackgroundTask => ({ ...task(kind, label), label })
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

  it('names one task alone by its label, and counts it beside anything else', () => {
    expect(watchPhrase(bg({ tasks: [labelled('  Sleep 45 seconds in the background ')] }))).toBe('Sleep 45 seconds in the background')
    expect(watchPhrase(bg({ tasks: [labelled('serve the app')], agents: ['a'] }))).toBe('a subagent, a command')
    expect(watchPhrase(bg({ tasks: [labelled('serve the app')], batch: { out: 1, total: 2 } }))).toBe('a batch thread, a command')
    expect(watchPhrase(bg({ tasks: [labelled('serve the app')], batch: { out: 0, total: 2 } }))).toBe('serve the app')
    expect(watchPhrase(bg({ tasks: [labelled('a'), labelled('b')] }))).toBe('2 commands')
    expect(watchSubject(bg({ tasks: [labelled('tail the log', 'monitor')] }))).toBe('tail the log')
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

describe('a subagent by its title', () => {
  const titles: Record<string, string> = {
    a: 'Review the payment flow',
    long: 'Audit every caller of the gateway forward path for missing deadlines and retries'
  }
  const titleOf = (id: string) => titles[id]

  it('names one subagent alone by its title, and counts it beside anything else', () => {
    expect(watchPhrase(bg({ agents: ['a'] }), titleOf)).toBe('Review the payment flow')
    expect(watchSubject(bg({ agents: ['a'] }), titleOf)).toBe('Review the payment flow')
    expect(watchPhrase(bg({ agents: ['nobody'] }), titleOf)).toBe('a subagent')
    expect(watchPhrase(bg({ agents: ['a'], tasks: [task('shell')] }), titleOf)).toBe('a subagent, a command')
    expect(watchPhrase(bg({ agents: ['a'], batch: { out: 1, total: 2 } }), titleOf)).toBe('a batch thread, a subagent')
    expect(watchPhrase(bg({ agents: ['a', 'long'] }), titleOf)).toBe('2 subagents')
  })

  it('reads a cross-host id by its bare session id', () => {
    expect(bareAgentId('env_AbC-12_x:a')).toBe('a')
    expect(bareAgentId('a')).toBe('a')
    expect(watchPhrase(bg({ agents: ['env_box:a'] }), titleOf)).toBe('Review the payment flow')
  })

  it('waits on one agent by title, several counted', () => {
    expect(waitSubject(['a'], titleOf)).toBe('Review the payment flow')
    expect(waitSubject(['nobody'], titleOf)).toBe('a subagent')
    expect(waitSubject(['a'])).toBe('a subagent')
    expect(waitSubject(['a', 'nobody'], titleOf)).toBe('2 subagents')
    expect(waitLine(['a'], titleOf)).toBe('Waiting on Review the payment flow')
    expect(waitLine(['a', 'b', 'c'], titleOf)).toBe('Waiting on 3 subagents')
  })

  it('cuts a long title at a word with an ellipsis', () => {
    expect(waitSubject(['long'], titleOf)).toBe('Audit every caller of the gateway forward path…')
    expect(waitSubject(['long'], titleOf).length).toBeLessThanOrEqual(48)
    expect(cutAtWord('short', 48)).toBe('short')
    expect(cutAtWord('x'.repeat(60), 48)).toBe(`${'x'.repeat(47)}…`)
  })
})
