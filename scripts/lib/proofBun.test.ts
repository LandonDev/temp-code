import { EventEmitter } from 'node:events'
import type { ChildProcess, spawn } from 'node:child_process'
import { expect, it, vi } from 'vitest'
import { preferredProofBun, runProofBun } from './proofBun'

it('selects the user runtime over an ancestor npm Bun and avoids a reexec loop', () => {
  const ops = { executable: () => true, realpath: (p: string) => p }
  expect(preferredProofBun('/home/person/node_modules/bun/bin/bun.exe', '/home/person', ops)).toBe(
    '/home/person/.bun/bin/bun'
  )
  expect(preferredProofBun('/home/person/.bun/bin/bun', '/home/person', ops)).toBeNull()
  expect(
    preferredProofBun('/system/bun', '/home/person', { ...ops, executable: () => false })
  ).toBeNull()
  expect(
    preferredProofBun('/symlink/bun', '/home/person', { ...ops, realpath: () => '/real/bun' })
  ).toBeNull()
})

it('forwards signals, retains gate args and reports the child exit code', async () => {
  const events = new EventEmitter()
  const child = Object.assign(new EventEmitter(), { kill: vi.fn() }) as unknown as ChildProcess
  const launch = vi.fn(() => child)
  const result = runProofBun('/user/bun', '/clone/proof.ts', ['--gate'], {
    spawn: launch as unknown as typeof spawn,
    events
  })
  expect(launch).toHaveBeenCalledWith('/user/bun', ['/clone/proof.ts', '--gate'], {
    env: process.env,
    stdio: 'inherit'
  })
  // Never its own process group: the gate's SIGKILL to the step's group must reach a child stuck in shutdown.
  expect((launch.mock.calls[0] as unknown[])[2]).not.toHaveProperty('detached')
  events.emit('SIGTERM')
  events.emit('SIGINT')
  events.emit('exit')
  expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
  expect(child.kill).toHaveBeenCalledTimes(1)
  child.emit('close', 7)
  expect(await result).toBe(7)
  expect(events.listenerCount('exit')).toBe(0)
  expect(events.listenerCount('SIGTERM')).toBe(0)
})

it('fails if the runtime cannot start', async () => {
  const events = new EventEmitter()
  const child = Object.assign(new EventEmitter(), { kill: vi.fn() }) as unknown as ChildProcess
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const result = runProofBun('/missing/bun', '/clone/proof.ts', ['--gate'], {
      spawn: (() => child) as unknown as typeof spawn,
      events
    })
    child.emit('error', new Error('missing'))
    expect(await result).toBe(1)
    expect(events.listenerCount('exit')).toBe(0)
  } finally {
    error.mockRestore()
  }
})
