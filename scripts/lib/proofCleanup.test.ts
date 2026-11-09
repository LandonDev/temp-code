import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { proofCleanup } from './proofCleanup'

function rig() {
  const events = new EventEmitter()
  const kill = vi.fn()
  const exit = vi.fn()
  const error = vi.fn()
  const cleanup = proofCleanup('/tmp/proof', {
    events: events as never,
    kill,
    exit,
    error,
    scan: {
      ppidOf: () => null,
      processes: () => [
        { pid: 24, command: 'electron', environment: ['TEMP_CODE_USER_DATA=/tmp/proof/mac-data'] },
        { pid: 25, command: 'bun fakeMcpServer /tmp/proof/calls', environment: [] },
        { pid: 26, command: 'electron', environment: ['TEMP_CODE_USER_DATA=/tmp/other/mac-data'] }
      ]
    }
  })
  const child = Object.assign(new EventEmitter(), { pid: 22 }) as ChildProcess
  cleanup.track(child, true)
  cleanup.track(Object.assign(new EventEmitter(), { pid: 23 }) as ChildProcess)
  return { events, kill, exit, error, cleanup, child }
}

describe('proof cleanup', () => {
  it('kills groups, direct children and escaped marked processes on normal exit', () => {
    const r = rig()
    r.events.emit('exit', 0)
    expect(r.kill.mock.calls).toEqual([
      [-22, 'SIGKILL'],
      [23, 'SIGKILL'],
      [24, 'SIGKILL'],
      [25, 'SIGKILL']
    ])
  })
  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['uncaughtException', 1],
    ['unhandledRejection', 1]
  ] as const)('cleans up on %s and returns failure', (event, code) => {
    const r = rig()
    r.events.emit(event, new Error('failed'))
    expect(r.kill).toHaveBeenCalledTimes(4)
    expect(r.exit).toHaveBeenCalledWith(code)
  })
  it('cleans up when spawning a child fails, even before the main try block', () => {
    const r = rig()
    r.child.emit('error', new Error('spawn failed'))
    expect(r.exit).toHaveBeenCalledWith(1)
    expect(r.kill).toHaveBeenCalledTimes(4)
  })
  it('still sweeps stragglers when tracked processes have already exited', () => {
    const r = rig()
    r.kill.mockImplementationOnce(() => {
      throw new Error('gone')
    })
    r.cleanup.stop()
    expect(r.kill).toHaveBeenCalledTimes(4)
  })
})
