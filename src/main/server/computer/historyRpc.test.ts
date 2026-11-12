import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ClientRequest } from '@shared/contract'
import { ClientRequestSchema } from '@shared/contract'
import { METHOD_CAPABILITY } from '@shared/capabilities'
import type { ComputerHistoryPush, ComputerHistoryReadAnswer, ComputerHistoryStep, ComputerHistoryStepAnswer } from '@shared/contract-computer'
import { ComputerHistory, HISTORY_PAGE } from './history'
import { ComputerHistoryRpc, handleComputerHistory } from './historyRpc'

const step = (verb: string): ComputerHistoryStep => ({ kind: 'click', verb, object: 'Save', inApp: 'Save in TextEdit' })
const start = () => ({ app: 'TextEdit', window: 'Untitled', steps: [step('Clicking')] })
const end = (extra: object = {}) => ({ app: 'TextEdit', window: 'Untitled', steps: [{ ...step('Clicked'), state: 'ok' as const }], ...extra })
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])

const open: { history: ComputerHistory; rpc: ComputerHistoryRpc }[] = []
function make() {
  const history = new ComputerHistory({ root: mkdtempSync(join(tmpdir(), 'tc-history-rpc-')) })
  const rpc = new ComputerHistoryRpc(history)
  open.push({ history, rpc })
  const socket = () => {
    const pushes: ComputerHistoryPush[] = []
    const viewer = { connection: {}, send: (p: ComputerHistoryPush) => void pushes.push(p) }
    const request = async (method: string, params: unknown) => {
      const req = ClientRequestSchema.parse({ id: '1', method, params }) as ClientRequest
      return handleComputerHistory(req, rpc, viewer)
    }
    return {
      pushes,
      viewer,
      read: async (keys: string[], before?: number) => (await request('computer.history.read', { keys, ...(before ? { before } : {}) })).result as ComputerHistoryReadAnswer,
      step: async (key: string, n: number) => (await request('computer.history.step', { key, n })).result as ComputerHistoryStepAnswer,
      close: () => rpc.dropConnection(viewer.connection)
    }
  }
  const shot = join(mkdtempSync(join(tmpdir(), 'tc-history-rpc-shot-')), 's.jpg')
  writeFileSync(shot, JPEG)
  return { history, rpc, socket, shot: { shot: { path: shot, width: 960, height: 804, capturedAt: 77 } } }
}
afterEach(async () => {
  for (const o of open.splice(0)) {
    o.rpc.close()
    await o.history.close()
  }
})

describe('computer.history.* (historyRpc.ts)', () => {
  it('both methods are local: this desktop’s own socket alone', () => {
    expect(METHOD_CAPABILITY['computer.history.read']).toBe('local')
    expect(METHOD_CAPABILITY['computer.history.step']).toBe('local')
  })

  it('a host without computer use keeps no journal: a read answers nothing kept, never a failure; every other method is left alone', async () => {
    const read = ClientRequestSchema.parse({ id: '1', method: 'computer.history.read', params: { keys: ['t1', 't2'] } }) as ClientRequest
    const viewer = { connection: {}, send: () => undefined }
    expect(await handleComputerHistory(read, null, viewer)).toEqual({
      handled: true,
      result: { sessions: [{ key: 't1', born: 0, calls: [], more: false }, { key: 't2', born: 0, calls: [], more: false }] }
    })
    const step = ClientRequestSchema.parse({ id: '2', method: 'computer.history.step', params: { key: 't1', n: 1 } }) as ClientRequest
    expect(await handleComputerHistory(step, null, viewer)).toEqual({ handled: true, result: {} })
    const other = ClientRequestSchema.parse({ id: '1', method: 'computer.sessions', params: {} }) as ClientRequest
    expect(await handleComputerHistory(other, null, viewer)).toEqual({ handled: false })
  })

  it('a read answers each key’s calls with its born, and a key with nothing', async () => {
    const m = make()
    await m.history.begin('t1', start()).end(end({ read: 'Read 3 changes', text: 'the read' }))
    const s = m.socket()
    const answer = await s.read(['t1', 'nobody'])
    expect(answer.sessions.map((x) => [x.key, x.calls.length, x.more, x.born > 0])).toEqual([['t1', 1, false, true], ['nobody', 0, false, false]])
    expect(answer.sessions[0].calls[0]).toMatchObject({ n: 1, state: 'done', read: 'Read 3 changes', text: true, rev: 2 })
  })

  it('the read’s bounds: the newest 200 of a key, then the 200 under before', async () => {
    const m = make()
    for (let i = 0; i < HISTORY_PAGE + 5; i++) void m.history.begin('t1', start()).end(end())
    const s = m.socket()
    const newest = (await s.read(['t1'])).sessions[0]
    expect([newest.calls.length, newest.calls[0].n, newest.more]).toEqual([HISTORY_PAGE, 6, true])
    const older = (await s.read(['t1'], 6)).sessions[0]
    expect([older.calls.map((c) => c.n), older.more]).toEqual([[1, 2, 3, 4, 5], false])
  })

  it('a step answers the picture’s bytes and the text', async () => {
    const m = make()
    const entry = m.history.begin('t1', start())
    await entry.end(end({ read: 'Read 3 changes', text: 'the read' }))
    await entry.picture(m.shot)
    const s = m.socket()
    expect(await s.step('t1', 1)).toEqual({ picture: { data: JPEG.toString('base64'), mimeType: 'image/jpeg', width: 960, height: 804, at: 77 }, text: 'the read' })
    expect(await s.step('t1', 9)).toEqual({})
  })

  it('a push reaches only the sockets that read the key, and none after they close', async () => {
    const m = make()
    const a = m.socket()
    const b = m.socket()
    const c = m.socket()
    await a.read(['t1'])
    await b.read(['t2'])
    await c.read(['t1', 't2'])
    const entry = m.history.begin('t1', start())
    await entry.n()
    expect(a.pushes.map((p) => [p.push, p.key, p.call?.state, p.call?.rev])).toEqual([['computer-history', 't1', 'running', 1]])
    expect(b.pushes).toEqual([])
    expect(c.pushes).toHaveLength(1)
    a.close()
    await entry.end(end())
    expect(a.pushes).toHaveLength(1)
    expect(c.pushes.map((p) => p.call?.state)).toEqual(['running', 'done'])
    await m.history.begin('t2', start()).n()
    expect(b.pushes.map((p) => p.key)).toEqual(['t2'])
    expect(c.pushes.map((p) => p.key)).toEqual(['t1', 't1', 't2'])
  })

  it('a key is heard from the read on: a record that lands while the read is out is pushed', async () => {
    const m = make()
    const s = m.socket()
    const reading = s.read(['t1'])
    const entry = m.history.begin('t1', start())
    await Promise.all([reading, entry.n()])
    expect(s.pushes.map((p) => p.call?.n)).toEqual([1])
    // a second read of the same socket adds keys and hears each change once
    await s.read(['t2'])
    await entry.end(end())
    expect(s.pushes.map((p) => p.call?.state)).toEqual(['running', 'done'])
  })

  it('a removed history says gone to its readers', async () => {
    const m = make()
    await m.history.begin('t1', start()).end(end())
    const s = m.socket()
    const other = m.socket()
    await s.read(['t1'])
    await other.read(['t2'])
    await m.history.remove('t1')
    expect(s.pushes).toEqual([{ push: 'computer-history', key: 't1', gone: true }])
    expect(other.pushes).toEqual([])
    expect((await s.read(['t1'])).sessions[0]).toEqual({ key: 't1', born: 0, calls: [], more: false })
  })
})
