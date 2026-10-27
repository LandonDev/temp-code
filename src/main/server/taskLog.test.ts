import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { BackgroundTask } from '@shared/events'
import { readTaskLog, type TaskLogDeps } from './taskLog'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tc-tasklog-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const task: BackgroundTask = { id: 't1', label: 'serve', kind: 'shell', startedAt: 0, callId: 'c1' }
const deps = (over: Partial<TaskLogDeps> = {}): TaskLogDeps => ({
  task: () => task,
  fileOfCall: () => null,
  fileOfTask: () => null,
  callOutput: () => null,
  ...over
})

it('reads the file its call named, then from the offset', async () => {
  const file = join(dir, 'tasks', 't1.output')
  await mkdir(join(dir, 'tasks'))
  await writeFile(file, 'one\n')
  const d = deps({ fileOfCall: (id) => (id === 'c1' ? file : null) })
  const first = await readTaskLog(d, 's1', 't1', undefined)
  expect(first).toEqual({ source: 'file', data: 'one\n', next: 4 })
  await appendFile(file, 'two\n')
  expect(await readTaskLog(d, 's1', 't1', first.next)).toEqual({ source: 'file', data: 'two\n', next: 8 })
  expect(await readTaskLog(d, 's1', 't1', 8)).toEqual({ source: 'file', data: '', next: 8 })
})

it('finds the file by task id when the task left the list', async () => {
  const file = join(dir, 't9.output')
  await writeFile(file, 'done\n')
  const d = deps({ task: () => null, fileOfTask: (id) => (id === 't9' ? file : null) })
  expect(await readTaskLog(d, 's1', 't9', undefined)).toEqual({ source: 'file', data: 'done\n', next: 5 })
})

it("falls back to the call's output in the transcript, then to none", async () => {
  const d = deps({ fileOfCall: () => join(dir, 'gone.output'), callOutput: (_s, id) => (id === 'c1' ? 'started' : null) })
  expect(await readTaskLog(d, 's1', 't1', undefined)).toEqual({ source: 'transcript', data: 'started', next: 7 })
  expect(await readTaskLog(d, 's1', 't1', 7)).toEqual({ source: 'transcript', data: '', next: 7 })
  expect(await readTaskLog(deps(), 's1', 't1', undefined)).toEqual({ source: 'none', data: '', next: 0 })
  expect(await readTaskLog(deps({ task: () => null }), 's1', 't1', undefined)).toEqual({ source: 'none', data: '', next: 0 })
})
