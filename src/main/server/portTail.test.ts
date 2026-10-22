import { describe, expect, it } from 'vitest'
import type { PortForwardInfo } from '@shared/contract-ports'
import type { ThreadResource } from '@shared/contract-resources'
import { PortTail } from './portTail'

const MAC = 'env_mac000000000000000000'
const row = (id: string, port: number, callId: string): ThreadResource => ({
  id,
  sessionId: 'root',
  environmentId: 'env_box',
  kind: 'port',
  identifier: String(port),
  label: 'bun run dev',
  branch: null,
  createdAt: 1,
  removeRequestedAt: null,
  removedAt: null,
  note: null,
  pid: 42,
  callId
})

function rig() {
  const rows = new Map<string, ThreadResource>()
  const forwards = new Map<string, PortForwardInfo[]>()
  const running = new Set<string>()
  const whispers: [string, string][] = []
  const timers: (() => void)[] = []
  let settled: ThreadResource[] = []
  const tail = new PortTail({
    settle: async () => settled,
    whenBound: async () => {},
    forwardsOf: (id) => forwards.get(id) ?? [],
    row: (id) => rows.get(id) ?? null,
    running: (callId) => running.has(callId),
    sessionOfCall: (callId) => (callId === 'sub' ? 'child' : null),
    whisper: (sessionId, text) => void whispers.push([sessionId, text]),
    setTimer: (fn) => void timers.push(fn)
  })
  const fire = () => {
    for (const t of timers.splice(0)) t()
  }
  return { tail, rows, forwards, running, whispers, fire, settle: (r: ThreadResource[]) => (settled = r) }
}

describe('PortTail', () => {
  it('names the Mac URL in the call result, and never whispers it again', async () => {
    const r = rig()
    const p = row('r1', 5173, 'c1')
    r.rows.set('r1', p)
    r.forwards.set('r1', [{ environmentId: MAC, hostName: 'Mac', macPort: 5174, error: null }])
    r.settle([p])
    expect(await r.tail.tail('root', 'c1', '')).toBe('Forwarded to http://localhost:5174 on the Mac (5173 is taken there)')
    r.tail.bound(['r1'])
    r.fire()
    expect(r.whispers).toEqual([])
  })

  it('answers nothing for a call that opened no port', async () => {
    expect(await rig().tail.tail('root', 'c1', 'ok')).toBeNull()
  })

  it('whispers a port bound after its call ended, once, to the session that ran the call', () => {
    const r = rig()
    r.rows.set('r1', row('r1', 3000, 'sub'))
    r.forwards.set('r1', [{ environmentId: MAC, hostName: 'Mac', macPort: 3000, error: null }])
    r.running.add('sub')
    r.tail.bound(['r1'])
    r.fire()
    expect(r.whispers).toEqual([])
    r.running.delete('sub')
    r.tail.callEnded(['r1'])
    r.fire()
    r.tail.bound(['r1'])
    r.fire()
    expect(r.whispers).toEqual([['child', '<dev-server port="3000">\nThe dev server bun run dev on port 3000: Forwarded to http://localhost:3000 on the Mac\n</dev-server>']])
  })

  it('says why a port was not forwarded', async () => {
    const r = rig()
    const p = row('r1', 5173, 'c1')
    r.forwards.set('r1', [{ environmentId: MAC, hostName: 'Mac', macPort: null, error: 'no free port from 5173 to 5273' }])
    r.settle([p])
    expect(await r.tail.tail('root', 'c1', '')).toBe('Port 5173 was not forwarded to the Mac: no free port from 5173 to 5273')
  })
})
