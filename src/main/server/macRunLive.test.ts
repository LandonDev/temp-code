import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, EventRow } from '@shared/events'
import { CLAUDE_MAC_RUN_NAME, LiveTail, MacRunCalls, MacRunLive } from './macRunLive'
import { toolUseIdOf } from './macTools'

afterEach(() => vi.useRealTimers())

let seq = 0
const row = (sessionId: string, event: AgentEvent): EventRow => ({
  sessionId,
  seq: ++seq,
  ts: Date.now(),
  event
})
const call = (sid: string, callId: string, name: string, input: unknown): EventRow =>
  row(sid, { type: 'tool-call', callId, name, input })
const result = (sid: string, callId: string): EventRow =>
  row(sid, { type: 'tool-result', callId, output: '{}', isError: false })

function harness(): {
  calls: MacRunCalls
  live: MacRunLive
  emitted: { sessionId: string; event: AgentEvent; at: number }[]
} {
  const calls = new MacRunCalls()
  const emitted: { sessionId: string; event: AgentEvent; at: number }[] = []
  const live = new MacRunLive({
    emit: (sessionId, event) => emitted.push({ sessionId, event, at: Date.now() }),
    calls
  })
  return { calls, live, emitted }
}
const frame = (
  seq: number,
  chunk: string,
  skipped = 0
): { seq: number; chunk: string; skipped: number } => ({ seq, chunk, skipped })

describe('MacRunCalls', () => {
  it('tracks open mac_run calls (Claude and Codex names) until their result', () => {
    const c = new MacRunCalls()
    c.observe(call('s', 'a', 'mcp__mac__mac_run', { argv: ['ls'] }))
    c.observe(call('s', 'b', 'app.mac_run', { argv: ['pwd'] }))
    c.observe(call('s', 'x', 'Bash', { command: 'ls' }))
    c.observe(call('s', 'y', 'mcp__mac__mac_read_file', { path: '/x' }))
    expect(c.openCount('s')).toBe(2)
    c.observe(result('s', 'a'))
    expect(c.openCount('s')).toBe(1)
  })

  it('a named call claims its row; an unnamed one the row with the same argv and cwd, then the oldest free', () => {
    const c = new MacRunCalls()
    c.observe(call('s', 'one', 'app.mac_run', { argv: ['make'], cwd: '/a' }))
    c.observe(call('s', 'two', 'app.mac_run', { argv: ['xcodebuild'], cwd: '/b' }))
    expect(c.claim('s', { argv: ['xcodebuild'], cwd: '/b' })?.callId).toBe('two')
    expect(c.claim('s', { argv: ['other'] })?.callId).toBe('one')
    expect(c.claim('s', { argv: ['make'], cwd: '/a' })).toBeNull()
    c.release('s', 'one')
    expect(c.claim('s', { argv: ['make'], cwd: '/a' })?.callId).toBe('one')
    // Named but not seen yet: the Claude face, with the args as the input.
    expect(c.claim('s', { argv: ['ls'] }, 'toolu_1')).toEqual({
      callId: 'toolu_1',
      name: CLAUDE_MAC_RUN_NAME,
      input: { argv: ['ls'] }
    })
  })
})

describe('LiveTail', () => {
  it('keeps the newest bytes from a line start and counts what scrolled off or was skipped', () => {
    const t = new LiveTail(10)
    t.add('aaaa\nbbbb\n')
    expect(t.output).toBe('aaaa\nbbbb\n')
    t.add('cccc\n', 3)
    expect(t.output).toBe('[… 8 earlier bytes …]\nbbbb\ncccc\n')
  })
})

describe('MacRunLive', () => {
  it("redraws the thread's own row as a partial tool-call with the output so far, every 250 ms", () => {
    vi.useFakeTimers()
    const { calls, live, emitted } = harness()
    const input = { argv: ['xcodebuild', '-scheme', 'App'], cwd: '/Users/me/app' }
    calls.observe(
      row('s', {
        type: 'tool-call',
        callId: 'item_7',
        name: 'app.mac_run',
        input,
        display: { app: 'Mac', action: 'run' }
      })
    )
    const run = live.open('s', input)
    for (let i = 0; i < 20; i++) {
      run.progress(frame(i, `line ${i}\n`))
      vi.advanceTimersByTime(100)
    }
    vi.advanceTimersByTime(300)
    expect(emitted.length).toBeGreaterThanOrEqual(8)
    expect(emitted.length).toBeLessThanOrEqual(9)
    for (let i = 1; i < emitted.length; i++)
      expect(emitted[i].at - emitted[i - 1].at).toBeGreaterThanOrEqual(250)
    const last = emitted.at(-1)!.event
    expect(last).toMatchObject({
      type: 'tool-call',
      callId: 'item_7',
      name: 'app.mac_run',
      input,
      partial: true,
      display: { app: 'Mac', action: 'run' },
      preview: { kind: 'shell' }
    })
    const output = (last as { preview: { output: string } }).preview.output
    expect(output).toBe(Array.from({ length: 20 }, (_, i) => `line ${i}\n`).join(''))
    expect(run.emitted).toBe(emitted.length)
  })

  it('a row the harness has not written yet is picked up when it lands', () => {
    vi.useFakeTimers()
    const { calls, live, emitted } = harness()
    const run = live.open('s', { argv: ['make'] })
    run.progress(frame(0, 'early\n'))
    vi.advanceTimersByTime(300)
    expect(emitted).toEqual([])
    calls.observe(call('s', 'item_1', 'app.mac_run', { argv: ['make'] }))
    vi.advanceTimersByTime(300)
    expect(emitted.length).toBe(1)
    expect(emitted[0].event).toMatchObject({ callId: 'item_1', preview: { output: 'early\n' } })
  })

  it('close() stops it at once and frees the row for the next run', () => {
    vi.useFakeTimers()
    const { calls, live, emitted } = harness()
    calls.observe(call('s', 'toolu_9', CLAUDE_MAC_RUN_NAME, { argv: ['ls'] }))
    const run = live.open('s', { argv: ['ls'] }, 'toolu_9')
    run.progress(frame(0, 'a\n'))
    vi.advanceTimersByTime(1)
    run.progress(frame(1, 'b\n'))
    run.close()
    vi.advanceTimersByTime(1_000)
    run.progress(frame(2, 'late\n'))
    vi.advanceTimersByTime(1_000)
    expect(emitted.length).toBe(1)
    expect(calls.claim('s', { argv: ['ls'] })?.callId).toBe('toolu_9')
  })

  it("reads Claude's tool_use id off the MCP call's _meta", () => {
    expect(toolUseIdOf({ _meta: { 'claudecode/toolUseId': 'toolu_abc' } })).toBe('toolu_abc')
    expect(toolUseIdOf({ _meta: {} })).toBeUndefined()
    expect(toolUseIdOf(undefined)).toBeUndefined()
  })
})
