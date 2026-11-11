import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PERF_CHILDREN, PERF_LOAD, PERF_THREADS, perfThread } from './lib/ios-perf-seeds'

const server = readFileSync(resolve(import.meta.dirname, 'ios-client-test-server.ts'), 'utf8')
const proof = readFileSync(resolve(import.meta.dirname, 'ios-sim-proof.sh'), 'utf8')
const local = readFileSync(resolve(import.meta.dirname, 'ios-sim-proof-local.ts'), 'utf8')

describe('the perf fixtures', () => {
  it('hold exactly the rows they name, closed and idle', () => {
    for (const thread of Object.values(PERF_THREADS)) {
      const events = perfThread(thread.id, thread)
      expect(events.length, thread.id).toBe(thread.rows)
      expect(events.filter((e) => e.type === 'user-text').length, thread.id).toBe(thread.turns)
      expect(events.filter((e) => e.type === 'turn-complete').length, thread.id).toBe(thread.turns)
      expect(events.at(-1), thread.id).toEqual({ type: 'status', status: 'idle' })
    }
  })

  it('are the same thread on every run', () => {
    const { build } = PERF_THREADS
    expect(JSON.stringify(perfThread(build.id, build))).toBe(JSON.stringify(perfThread(build.id, build)))
  })

  it('carry the mix a long agent thread holds', () => {
    const { build } = PERF_THREADS
    const events = perfThread(build.id, build)
    const calls = events.filter((e) => e.type === 'tool-call')
    const names = new Set(calls.map((e) => (e.type === 'tool-call' ? e.name : '')))
    for (const name of ['Read', 'Bash', 'Edit', 'TodoWrite', 'mcp__orchestrator__spawn_agent']) expect(names.has(name), name).toBe(true)
    expect(events.some((e) => e.type === 'agent-report')).toBe(true)
    const outputs = events.flatMap((e) => (e.type === 'tool-result' && typeof e.output === 'string' ? [e.output.length] : []))
    expect(Math.max(...outputs)).toBeLessThanOrEqual(2_600)
    expect(Math.max(...outputs)).toBeGreaterThan(1_000)
    const edits = calls.flatMap((e) => (e.type === 'tool-call' && e.name === 'Edit' ? [e.preview?.lines?.length ?? 0] : []))
    expect(Math.min(...edits)).toBeGreaterThanOrEqual(20)
    expect(Math.max(...edits)).toBeLessThanOrEqual(400)
    expect(Math.max(...edits)).toBeGreaterThan(150)
    const replies = events.flatMap((e) => (e.type === 'assistant-text' ? [e.text] : []))
    expect(replies.some((t) => t.includes('```ts'))).toBe(true)
    expect(replies.some((t) => t.includes('| --- |'))).toBe(true)
    expect(replies.some((t) => t.includes('\n- '))).toBe(true)
    // Every shell call is backgrounded: the host's process guard would end each foreground one through `ps` when the thread closes.
    const shells = calls.filter((e) => e.type === 'tool-call' && e.name === 'Bash')
    expect(shells.length).toBeGreaterThan(1_000)
    expect(shells.every((e) => e.type === 'tool-call' && (e.input as { run_in_background?: boolean }).run_in_background === true)).toBe(true)
    // Every call id is its own: a repeat would fold two calls into one row.
    const ids = calls.map((e) => (e.type === 'tool-call' ? e.callId : ''))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('name eight children and twelve sessions for the load', () => {
    expect(PERF_CHILDREN).toHaveLength(8)
    expect(PERF_LOAD).toHaveLength(12)
  })
})

describe('the test server', () => {
  it('seeds the perf threads only when asked, so the gate boots no slower', () => {
    expect(server).toMatch(/if \(process\.env\.TC_TEST_PERF_SEEDS === '1'\) \{[\s\S]*perfThread\(/)
  })
  it('plays a stream by frames or rows and the other traffic on its own', () => {
    expect(server).toMatch(/case '\/load':/)
    expect(server).toMatch(/frames: count\(body\.frames\)/)
    expect(server).toMatch(/rows: count\(body\.rows\)/)
  })
  it('goes quiet between runs: the load and a stream stop, and the stream\'s turn ends', () => {
    const quiet = server.slice(server.indexOf("case '/quiet':"), server.indexOf("case '/load':"))
    expect(quiet).toMatch(/loadRun\.stopped = true/)
    expect(quiet).toMatch(/stream\.stopped = true[\s\S]*turn-complete[\s\S]*status: 'idle'/)
    expect(proof).toMatch(/simctl terminate[^\n]*\n[^\n]*\n\s*curl[^\n]*\/quiet/)
  })
  it('opens the Simulator window for no perf run, and for no set that asks to run headless', () => {
    expect(proof).toMatch(/\[ "\$SET" = perf \] \|\| \[ "\$\{TC_PROOF_HEADLESS:-\}" = 1 \] \|\| open -g -a/)
    expect([...proof.matchAll(/open -g -a/g)]).toHaveLength(1)
  })
  it('runs its helper children from a broker process when the proof names one', () => {
    expect(server).toMatch(/process\.env\.TC_TEST_EXEC_BROKER/)
    expect(server).toMatch(/spawnExecBroker,/)
    expect(local).toMatch(/TC_TEST_EXEC_BROKER: broker/)
  })
})
