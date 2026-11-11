import { afterEach, expect, it, vi } from 'vitest'
import { bridgeCancelledProbeRead, bridgeHasOneRemoteNote, bridgeHeldId, bridgeProbeEnvironment, bridgeProbePing, waitForBridgeProofCall } from './computerBridgeProof'
import { COMPUTER_BRIDGE_NOTE, COMPUTER_TOOLS, ComputerActInputSchema, ComputerResultInputSchema } from '../../src/shared/computer/tools'
import { heldAnswerLine } from '../../src/shared/computer/heldCalls'
import { markersOf } from '../../src/main/server/processGuard'

afterEach(() => vi.useRealTimers())

it('requires the remote note on computer_apps alone and rejects missing or repeated notes', () => {
  const local = [...COMPUTER_TOOLS.map(({ name, description }) => ({ name, description })), { name: 'computer_result', description: 'Read a held call.' }]
  const on = (names: string[]) => local.map((t) => ({ ...t, description: t.description + (names.includes(t.name) ? COMPUTER_BRIDGE_NOTE : '') }))
  expect(bridgeHasOneRemoteNote(on(['computer_apps']))).toBe(true)
  expect(bridgeHasOneRemoteNote(local)).toBe(false)
  expect(bridgeHasOneRemoteNote(on(local.map((t) => t.name)))).toBe(false)
  expect(bridgeHasOneRemoteNote(on(['computer_result']))).toBe(false)
  expect(bridgeHasOneRemoteNote([])).toBe(false)
})

it('keeps the launchd-owned probe out of the agent orphan sweep without unmarking its runner', () => {
  const runner = {
    PATH: '/usr/bin', HOME: '/tmp/proof-home', TC_PROOF_UNGATED: '1', TEMP_CODE_COMPUTER_PROOF: '1',
    TEMP_CODE_THREAD: 't1', TEMP_CODE_CALL: 'c1', TEMP_CODE_INSTANCE: 'instance1', TEMP_CODE_ADDON: 'addon1',
    CLAUDE_PID: '77', ANTHROPIC_BASE_URL: 'http://127.0.0.1/claude/~t=t1'
  }
  const environ = (env: NodeJS.ProcessEnv): string => Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\0')
  expect(markersOf(environ(runner))).toMatchObject({ threadId: 't1', callId: 'c1', instanceId: 'instance1', claudePid: 77 })
  const probe = bridgeProbeEnvironment(runner)
  expect(markersOf(environ(probe))).toEqual({ threadId: null, callId: null, instanceId: null, claudePid: null })
  expect(probe).toEqual({ PATH: '/usr/bin', HOME: '/tmp/proof-home', TC_PROOF_UNGATED: '1', TEMP_CODE_COMPUTER_PROOF: '1' })
  expect(runner.TEMP_CODE_THREAD).toBe('t1')
  expect(runner.TEMP_CODE_CALL).toBe('c1')
})

it('sends the full observation’s Ping index and the held answer’s id in valid tool inputs', () => {
  const element = bridgeProbePing('app "TC Probe"\n[3] button "Ping"\n[4] button "Ping Window"')
  expect(ComputerActInputSchema.parse({ app: 'TC Probe', action: 'left_click', element }).element).toBe(3)
  const id = bridgeHeldId(heldAnswerLine('c12', 3000, 'Waiting for the Mac, 1 of 1 computer sessions, 1st in line'))
  expect(ComputerResultInputSchema.parse({ id })).toEqual({ id: 'c12' })
})

it('stops on a change-only tree instead of serializing NaN as a null element', () => {
  expect(() => bridgeProbePing('app "TC Probe" · no changes · thin tree, see the screenshot')).toThrow('no Ping button')
  expect(() => bridgeProbePing('[4] button "Ping Window"')).toThrow('no Ping button')
})

it('stops on a refused click instead of sending computer_result without an id', () => {
  expect(() => bridgeHeldId('invalid arguments: element: expected number, received null')).toThrow('did not answer held with an id')
  expect(() => bridgeHeldId('left_click [3] button "Ping" · ax · changed')).toThrow('did not answer held with an id')
})

it('does not pass a cancellation-prefixed observation that lost TC Probe', () => {
  const cancelled = 'Cancelled c2 (left_click [3] in TC Probe) before it ran.'
  expect(bridgeCancelledProbeRead(`${cancelled}\n\nno app matches "TC Probe"`, true)).toBe(false)
  expect(bridgeCancelledProbeRead(`${cancelled}\n\napp "TC Probe" · window "TC Probe"`, false)).toBe(true)
  expect(bridgeCancelledProbeRead('app "TC Probe" · window "TC Probe"', false)).toBe(false)
})

it('keeps waiting through a load hold longer than the harness grace, then returns the real answer', async () => {
  vi.useFakeTimers()
  let finish!: (value: string) => void
  const log = vi.fn()
  const waiting = waitForBridgeProofCall(new Promise<string>((resolve) => { finish = resolve }), {
    standing: async () => 'load 38.3 of 32, 1st in line', log
  })
  let ended = false
  void waiting.then(() => { ended = true })
  await vi.advanceTimersByTimeAsync(30_000)
  expect(ended).toBe(false)
  expect(log).toHaveBeenCalledExactlyOnceWith('waiting for the Mac: load 38.3 of 32, 1st in line')
  finish('window "TC Probe"')
  await expect(waiting).resolves.toBe('window "TC Probe"')
  expect(vi.getTimerCount()).toBe(0)
})

it('fails within the bound with the last standing, so finally can end the held call', async () => {
  vi.useFakeTimers()
  const waiting = waitForBridgeProofCall(new Promise(() => {}), {
    standing: async () => 'computer cap, 1st in line', log: vi.fn(), timeoutMs: 3_000
  })
  const failed = expect(waiting).rejects.toThrow('within 3 s: computer cap, 1st in line')
  await vi.advanceTimersByTimeAsync(3_000)
  await failed
  expect(vi.getTimerCount()).toBe(0)
})

it('returns a refusal as is and drops its timers', async () => {
  vi.useFakeTimers()
  await expect(waitForBridgeProofCall(Promise.reject(new Error('offline')), {
    standing: vi.fn(), log: vi.fn()
  })).rejects.toThrow('offline')
  expect(vi.getTimerCount()).toBe(0)
})
