import { describe, expect, it } from 'vitest'
import type { PortForwardInfo } from '@shared/contract-ports'
import type { ThreadResource } from '@shared/contract-resources'
import { backgroundedCall, devServerLine, oneServerLine, PortTail } from './portTail'

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

function rig(others: (row: ThreadResource) => number[] = () => []) {
  const rows = new Map<string, ThreadResource>()
  const forwards = new Map<string, PortForwardInfo[]>()
  const running = new Set<string>()
  const whispers: [string, string][] = []
  const timers: (() => void)[] = []
  let settled: ThreadResource[] = []
  let portsOf: (callId: string) => ThreadResource[] = () => []
  const tail = new PortTail({
    settle: async () => settled,
    whenBound: async () => {},
    forwardsOf: (id) => forwards.get(id) ?? [],
    row: (id) => rows.get(id) ?? null,
    running: (callId) => running.has(callId),
    sessionOfCall: (callId) => (callId === 'sub' ? 'child' : null),
    portsOf: (callId) => portsOf(callId),
    sleep: async () => {},
    whisper: (sessionId, text) => void whispers.push([sessionId, text]),
    others,
    setTimer: (fn) => void timers.push(fn)
  })
  const fire = () => {
    for (const t of timers.splice(0)) t()
  }
  return { tail, rows, forwards, running, whispers, fire, settle: (r: ThreadResource[]) => (settled = r), setPortsOf: (f: typeof portsOf) => (portsOf = f) }
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

  it('with no Mac to forward to, the call result says where the server listens here', async () => {
    const r = rig()
    const p = row('r1', 5173, 'c1')
    r.rows.set('r1', p)
    r.settle([p])
    expect(await r.tail.tail('root', 'c1', '')).toBe('The dev server (bun run dev) is listening on http://localhost:5173')
    expect(devServerLine(p, [])).toBe('The dev server (bun run dev) is listening on http://localhost:5173')
    // A Mac still binding: nothing yet, the whisper follows the binding.
    expect(devServerLine(p, [{ environmentId: MAC, hostName: 'Mac', macPort: null, error: null }])).toBeNull()
    expect(devServerLine(p, [{ environmentId: MAC, hostName: 'Mac', macPort: 5174, error: null }])).toBe('Forwarded to http://localhost:5174 on the Mac (5173 is taken there)')
  })

  it("a backgrounded call's listener found inside the wait rides the result, and its row is not whispered again; one never found is whispered once it lands", async () => {
    const r = rig()
    const p = row('r1', 5173, 'c1')
    r.rows.set('r1', p)
    let polls = 0
    r.setPortsOf((callId) => (callId === 'c1' && ++polls >= 3 ? [p] : []))
    const output = 'Command running in background with ID: b1. Output is being written to: /tmp/x/b1.output'
    expect(backgroundedCall(output)).toBe(true)
    expect(backgroundedCall('ok')).toBe(false)
    expect(await r.tail.tail('root', 'c1', output)).toBe('The dev server (bun run dev) is listening on http://localhost:5173')
    expect(polls).toBe(3)
    r.tail.recorded(['r1'])
    r.fire()
    expect(r.whispers).toEqual([])
    const q = row('r2', 3000, 'c2')
    r.rows.set('r2', q)
    r.setPortsOf(() => [])
    expect(await r.tail.tail('root', 'c2', output)).toBeNull()
    r.tail.recorded(['r2'])
    r.fire()
    expect(r.whispers).toEqual([['root', '<dev-server port="3000">\nThe dev server (bun run dev) is listening on http://localhost:3000\n</dev-server>']])
  })

  it('a row the sweep recorded with no call and no Mac is whispered to its thread once', () => {
    const r = rig()
    r.rows.set('r1', { ...row('r1', 5173, 'c1'), callId: null })
    r.tail.recorded(['r1'])
    r.fire()
    r.tail.recorded(['r1'])
    r.fire()
    expect(r.whispers).toEqual([['root', '<dev-server port="5173">\nThe dev server (bun run dev) is listening on http://localhost:5173\n</dev-server>']])
  })

  it('says why a port was not forwarded', async () => {
    const r = rig()
    const p = row('r1', 5173, 'c1')
    r.forwards.set('r1', [{ environmentId: MAC, hostName: 'Mac', macPort: null, error: 'no free port from 5173 to 5273' }])
    r.settle([p])
    expect(await r.tail.tail('root', 'c1', '')).toBe('Port 5173 was not forwarded to the Mac: no free port from 5173 to 5273')
  })

  it('never announces a port that is not a dev server: the gate’s worker, a test run', async () => {
    const r = rig()
    const gate = { ...row('g1', 37095, 'c1'), label: '/srv/agents/home/.bun/bin/bun scripts/gate.ts --tier commit --since 4bf3892c' }
    r.rows.set('g1', gate)
    r.forwards.set('g1', [{ environmentId: MAC, hostName: 'Mac', macPort: 37095, error: null }])
    r.settle([gate])
    expect(await r.tail.tail('root', 'c1', '')).toBeNull()
    r.tail.bound(['g1'])
    r.fire()
    expect(r.whispers).toEqual([])
  })

  it('tells a thread that already runs a dev server to keep one, unless this one is for a different feature', async () => {
    const r = rig((p) => (p.id === 'r2' ? [5173] : []))
    const second = row('r2', 3000, 'c2')
    r.rows.set('r2', second)
    r.forwards.set('r2', [{ environmentId: MAC, hostName: 'Mac', macPort: 3000, error: null }])
    r.settle([second])
    expect(await r.tail.tail('root', 'c2', '')).toBe(`Forwarded to http://localhost:3000 on the Mac\n${oneServerLine([5173])}`)
    expect(oneServerLine([5173])).toBe(
      'This thread already runs a dev server on port 5173. Keep one dev server per thread: if this one replaces it, stop the old one; keep both only if this one is for a different feature, and say which.'
    )
    expect(oneServerLine([5173, 3000])).toContain('dev servers on ports 5173, 3000')
  })
})
