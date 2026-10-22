import { describe, expect, it } from 'vitest'
import type { ThreadResource } from '@server/shared/contract-resources'
import { portLine, portOfCall, portOpen, rowOpen } from './devPorts'

const MAC = 'env_mac'
const BOX = 'env_box'
const row = (over: Partial<ThreadResource> = {}): ThreadResource => ({
  id: 'r1',
  sessionId: 'root',
  environmentId: BOX,
  kind: 'port',
  identifier: '5173',
  label: 'http://localhost:5173',
  branch: null,
  createdAt: 1,
  removeRequestedAt: null,
  removedAt: null,
  note: null,
  pid: 42,
  callId: 'c1',
  forwards: [{ environmentId: MAC, hostName: 'Mac', macPort: 5174, error: null }],
  ...over
})

describe('devPorts', () => {
  it('opens a box port through its forward here, saying it moved', () => {
    expect(rowOpen(row(), MAC)).toEqual({ label: 'Open on the Mac', url: 'http://localhost:5174', port: 5174, movedFrom: 5173 })
    expect(portLine(row(), MAC)).toBe('localhost:5174 · 5173 is taken here')
  })

  it('opens this Mac’s own port as it is', () => {
    expect(portOpen(3000, MAC, undefined, MAC)).toEqual({ label: 'Open in browser', url: 'http://localhost:3000', port: 3000, movedFrom: null })
    expect(portLine(row({ environmentId: MAC, forwards: [] }), MAC)).toBe('localhost:5173')
  })

  it('offers nothing without a forward here, and says why', () => {
    expect(rowOpen(row({ forwards: [] }), MAC)).toBeNull()
    expect(portLine(row({ forwards: [] }), MAC)).toBe('Not forwarded to this Mac')
    const failed = row({ forwards: [{ environmentId: MAC, hostName: null, macPort: null, error: 'no free port from 5173 to 5273' }] })
    expect(portLine(failed, MAC)).toBe('Not forwarded: no free port from 5173 to 5273')
    expect(rowOpen(row(), null)).toBeNull()
    expect(rowOpen(row({ kind: 'worktree' }), MAC)).toBeNull()
  })

  it('finds the live port a call opened in any thread', () => {
    const bySession = { a: [row({ id: 'x', callId: 'other' })], root: [row({ removedAt: 5 }), row({ id: 'r2' })] }
    expect(portOfCall(bySession, 'c1')?.id).toBe('r2')
    expect(portOfCall(bySession, 'nope')).toBeNull()
  })
})
