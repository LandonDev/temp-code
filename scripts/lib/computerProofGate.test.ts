import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sourceStamp } from './tcComputerBuild'
import * as proofOrder from './proofOrder'
import { computerHarness } from '../../src/main/server/computer/runHarness'
import { permissionPromptedSetting } from '../../src/main/server/computer/run'
import { SessionHolds } from '../../src/main/server/computer/hold'
import type { ComputerService } from '../../src/main/server/computer/service'
import type { ComputerSessions } from '../../src/main/server/computer/sessions'
import {
  computerProofMode,
  computerProofPolicy,
  requireGateNative,
  waitForComputerProof,
  SCREEN_RECORDING_PROMPTED
} from './computerProofGate'

const grants = (screenRecording: boolean) => ({ accessibility: true, screenRecording })
describe('unattended computer proof policy', () => {
  it('seeds the host prompt marker and sends text-only calls without Screen Recording', () => {
    const policy = computerProofPolicy(true, grants(false))
    expect(new Map(policy.settings).get(SCREEN_RECORDING_PROMPTED)).toBe('1')
    expect(policy.pictures).toBe(false)
    const sent: unknown[] = []
    for (const args of [{ app: 'TC Probe' }, { app: 'TC Probe', screenshot: true }]) {
      const params = policy.observeArgs(args)
      policy.assertRequest('computer_observe', params)
      sent.push(params)
    }
    expect(sent).toEqual([
      { app: 'TC Probe', screenshot: false },
      { app: 'TC Probe', screenshot: false }
    ])
    for (const [method, params] of [
      ['permissions.request', { which: 'screenRecording' }],
      ['state.get', {}],
      ['action.run', {}],
      ['computer_act', { action: 'screenshot', screenshot: false }],
      ['capture.screenshot', {}],
      ['capture.stream.start', {}],
      ['state.get', { screenshot: 'auto' }],
      ['computer_observe', { screenshot: true }],
      ['action.run', { action: { action: 'screenshot' } }],
      ['action.batch', { actions: [{ action: 'zoom' }] }],
      ['action.run', { observe: { screenshot: 'always' } }]
    ] as const)
      expect(() => policy.assertRequest(method, params)).toThrow()
  })
  it('allows pictures only with the grant, and never requests a grant', () => {
    const policy = computerProofPolicy(true, grants(true))
    expect(policy.settings).toEqual([])
    expect(policy.observeArgs({ screenshot: true })).toEqual({ screenshot: true })
    expect(() => policy.assertRequest('capture.screenshot', {})).not.toThrow()
    expect(() =>
      policy.assertRequest('permissions.request', { which: 'screenRecording' })
    ).toThrow()
  })
  it('--gate cannot turn on escape.watch, including the SessionHolds path', () => {
    for (const recording of [false, true]) {
      const policy = computerProofPolicy(true, grants(recording))
      expect(policy.escapeWatch).toBe(false)
      const sent: unknown[] = []
      const request = (params: unknown) => {
        policy.assertRequest('escape.watch', params)
        sent.push(params)
      }
      expect(() => request({ on: true, leaseMs: 1_000 })).toThrow('cannot take Escape')
      request({ on: false })
      expect(sent).toEqual([{ on: false }])
    }
    expect(computerProofPolicy(false, grants(true)).escapeWatch).toBe(true)
  })
})

// Exercise the actual host as well as the pure rule: this test runs on Linux.

it('the host receives no picture request and never prompts with the gate seed', async () => {
  const policy = computerProofPolicy(true, grants(false))
  expect(SCREEN_RECORDING_PROMPTED).toBe(permissionPromptedSetting('screenRecording'))
  const h = computerHarness()
  for (const [key, value] of policy.settings) h.store.setSetting(key, value)
  try {
    // NoShot is the fake's app without Screen Recording; no real app opens here.
    const result = await h.run(
      'computer_observe',
      policy.observeArgs({ app: 'NoShot', screenshot: true })
    )
    expect(result.isError).toBe(false)
    const reads = h.requests().filter((r) => r.method === 'state.get')
    expect(reads.length).toBeGreaterThan(0)
    for (const read of reads) expect(read.params.screenshot).toBe('never')
    expect(
      h
        .requests()
        .some((r) => r.method === 'permissions.request' || r.method.startsWith('capture.'))
    ).toBe(false)
    // A late service-side permission error must also honor the seeded prompt marker.
    const request = h.service.request.bind(h.service)
    h.service.request = (async (method, params, opts) => {
      const answer = await request(method, params, opts)
      return method === 'state.get'
        ? {
            ...answer,
            shotError: { kind: 'permission_missing', which: 'screenRecording', message: 'off' }
          }
        : answer
    }) as typeof h.service.request
    await h.run('computer_observe', policy.observeArgs({ app: 'NoShot' }))
    expect(h.requests().filter((r) => r.method === 'permissions.request')).toEqual([])
  } finally {
    await h.close()
    rmSync(h.dataDir, { recursive: true, force: true })
    rmSync(h.landingRoot, { recursive: true, force: true })
  }
})

it('gate implies a local pair, explicit local works, and the default preserves SSH', () => {
  expect(computerProofMode(['--gate'])).toEqual({ gate: true, localPair: true })
  expect(computerProofMode(['--pair', 'local'])).toEqual({ gate: false, localPair: true })
  expect(computerProofMode([])).toEqual({ gate: false, localPair: false })
  expect(computerProofMode(['--pair', 'ssh'])).toEqual({ gate: false, localPair: false })
})

it('a gate rejects a missing or stale native build before it could compile', () => {
  const root = mkdtempSync(join(tmpdir(), 'tc-gate-stamp-'))
  try {
    mkdirSync(join(root, 'native/tc-computer'), { recursive: true })
    mkdirSync(join(root, 'resources/native'), { recursive: true })
    writeFileSync(join(root, 'native/tc-computer/Package.swift'), '// fixture')
    expect(() => requireGateNative(root)).toThrow('current shipped tc-computer')
    const bin = join(root, 'resources/native/tc-computer')
    writeFileSync(bin, 'fixture')
    writeFileSync(`${bin}.stamp`, JSON.stringify({ stamp: 'old' }))
    expect(() => requireGateNative(root)).toThrow('current shipped tc-computer')
    writeFileSync(`${bin}.stamp`, JSON.stringify({ stamp: sourceStamp(root) }))
    expect(() => requireGateNative(root)).not.toThrow()
    writeFileSync(join(root, 'native/tc-computer/Package.swift'), '// changed')
    expect(() => requireGateNative(root)).toThrow('current shipped tc-computer')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('the preview guard stops SessionHolds before it can send escape.watch on', async () => {
  const policy = computerProofPolicy(true, grants(true))
  const sent: { method: string; params: unknown }[] = []
  const service = {
    onNotification: () => () => {},
    onEpoch: () => () => {},
    request: async (method: string, params: unknown) => {
      policy.assertRequest(method, params)
      sent.push({ method, params })
      return {}
    }
  } as unknown as ComputerService
  const holds = new SessionHolds({ service, sessions: {} as ComputerSessions, banner: () => null })
  try {
    holds.holder({ thread: null })
    await Promise.resolve()
    expect(sent).toEqual([])
  } finally {
    holds.close()
  }
  expect(
    sent.every((r) => r.method !== 'escape.watch' || (r.params as { on: boolean }).on === false)
  ).toBe(true)
})

it('waits for an older proof, then proceeds when its turn arrives', async () => {
  vi.useFakeTimers()
  const other = vi
    .spyOn(proofOrder, 'otherProof')
    .mockReturnValueOnce('e2e-computer-bridge')
    .mockReturnValue(null)
  const log = vi.fn()
  try {
    const waiting = waitForComputerProof(log, 2_000)
    expect(log).toHaveBeenCalledWith('waiting for the older computer proof: e2e-computer-bridge')
    await vi.advanceTimersByTimeAsync(1_000)
    await waiting
    expect(other).toHaveBeenCalledTimes(2)
  } finally {
    vi.useRealTimers()
    other.mockRestore()
  }
})

it('fails within its proof wait budget', async () => {
  vi.useFakeTimers()
  const other = vi.spyOn(proofOrder, 'otherProof').mockReturnValue('e2e-tc-computer')
  try {
    const waiting = expect(waitForComputerProof(() => {}, 1_000)).rejects.toThrow(
      'another computer proof still runs'
    )
    await vi.advanceTimersByTimeAsync(1_000)
    await waiting
  } finally {
    vi.useRealTimers()
    other.mockRestore()
  }
})
