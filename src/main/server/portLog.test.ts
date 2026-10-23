import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ThreadResource } from '@shared/contract-resources'
import { PortLogs } from './portLog'
import { SharedScanner } from './threadPorts'

const row = (over: Partial<ThreadResource> = {}): ThreadResource =>
  ({ id: 'r1', kind: 'port', identifier: '8081', pid: null, callId: 'c1', removedAt: null, note: null, ...over }) as ThreadResource

const logs = (r: ThreadResource, callFile: string | null) =>
  new PortLogs({ row: () => r, callFile: () => callFile, callOutput: () => 'from the transcript\n', scanner: new SharedScanner(async () => ({ listeners: [], parents: new Map() })) })

describe('PortLogs', () => {
  it('reads the file the shell call named once the process is gone', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'portlog-')), 'b1.output')
    writeFileSync(file, 'Metro waiting on exp://\n')
    const log = await logs(row(), file).read('r1', undefined)
    expect(log).toMatchObject({ source: 'file', path: file, data: 'Metro waiting on exp://\n' })
    expect(log.endedAt).toBeUndefined()
  })

  it('says when the server ended and why', async () => {
    const log = await logs(row({ removedAt: 5, note: 'stopped listening' }), null).read('r1', undefined)
    expect(log).toMatchObject({ source: 'transcript', data: 'from the transcript\n', endedAt: 5, note: 'stopped listening' })
  })
})
