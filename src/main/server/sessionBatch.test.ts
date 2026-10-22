import { describe, expect, it } from 'vitest'
import { batchChildIds, batchRoots, runSessionBatch, SESSION_BATCH_WIDTH } from './sessionBatch'

const identity = (id: string) => id

describe('batchRoots', () => {
  it('maps every id to its root once, in the order given', () => {
    const rootOf = (id: string) => (id.startsWith('child-') ? id.slice('child-'.length) : id)
    expect(batchRoots(['child-a', 'b', 'a', 'child-b', 'c'], rootOf)).toEqual(['a', 'b', 'c'])
  })
  it('keeps an id the registry cannot place', () => {
    const rootOf = (id: string) => {
      if (id === 'gone') throw new Error('no session gone')
      return id
    }
    expect(batchRoots(['gone', 'a'], rootOf)).toEqual(['gone', 'a'])
  })
})

describe('runSessionBatch', () => {
  it('runs at most four calls at once and reports each id', async () => {
    let inFlight = 0
    let peak = 0
    const started: string[] = []
    const run = async (_action: string, id: string) => {
      started.push(id)
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight--
      if (id === 's3') throw new Error('harness not responding')
    }
    const ids = Array.from({ length: 10 }, (_, i) => `s${i}`)
    const result = await runSessionBatch('pause', ids, { rootOf: identity, run })
    expect(peak).toBe(SESSION_BATCH_WIDTH)
    expect(started).toEqual(ids)
    expect(result.attempted).toEqual(ids)
    expect(result.succeeded).toEqual(ids.filter((id) => id !== 's3'))
    expect(result.failed).toEqual([{ sessionId: 's3', error: 'harness not responding' }])
  })

  it('answers an empty batch without calling anything', async () => {
    let calls = 0
    const result = await runSessionBatch('stop', [], {
      rootOf: identity,
      run: async () => {
        calls++
      }
    })
    expect(calls).toBe(0)
    expect(result).toEqual({ attempted: [], succeeded: [], failed: [] })
  })

  it('pauses a subagent through its parent, once', async () => {
    const calls: string[] = []
    const rootOf = (id: string) => (id === 'sub' ? 'parent' : id)
    const result = await runSessionBatch('pause', ['sub', 'parent', 'other'], {
      rootOf,
      run: async (_a, id) => {
        calls.push(id)
      }
    })
    expect(calls).toEqual(['parent', 'other'])
    expect(result.succeeded).toEqual(['parent', 'other'])
  })

  it('cleans up after an archive only when asked, and a failed clean-up is the row’s failure', async () => {
    const cleaned: string[] = []
    const deps = {
      rootOf: identity,
      run: async () => {},
      cleanup: async (id: string) => {
        if (id === 'b') throw new Error('worktree busy')
        cleaned.push(id)
      }
    }
    const quiet = await runSessionBatch('archive', ['a', 'b'], deps)
    expect(cleaned).toEqual([])
    expect(quiet.failed).toEqual([])
    const loud = await runSessionBatch('archive', ['a', 'b'], deps, { cleanup: true })
    expect(cleaned).toEqual(['a'])
    expect(loud.failed).toEqual([{ sessionId: 'b', error: 'worktree busy' }])
    const paused = await runSessionBatch('pause', ['a'], deps, { cleanup: true })
    expect(cleaned).toEqual(['a'])
    expect(paused.succeeded).toEqual(['a'])
  })

  it('reports a non-Error rejection as text', async () => {
    const result = await runSessionBatch('resume', ['a'], {
      rootOf: identity,
      run: async () => {
        throw 'nope'
      }
    })
    expect(result.failed).toEqual([{ sessionId: 'a', error: 'nope' }])
  })
})

describe('batchChildIds', () => {
  it("names a master's unarchived root threads oldest first, never a subagent, an archived one or the master itself", () => {
    const rows = [
      { id: 'm', parentId: null, masterId: null, archived: false, createdAt: 1 },
      { id: 'b', parentId: null, masterId: 'm', archived: false, createdAt: 3 },
      { id: 'a', parentId: null, masterId: 'm', archived: false, createdAt: 2 },
      { id: 'sub', parentId: 'a', masterId: 'm', archived: false, createdAt: 4 },
      { id: 'gone', parentId: null, masterId: 'm', archived: true, createdAt: 5 },
      { id: 'other', parentId: null, masterId: 'n', archived: false, createdAt: 6 },
      { id: 'self', parentId: null, masterId: 'self', archived: false, createdAt: 7 }
    ]
    expect(batchChildIds(rows, 'm')).toEqual(['a', 'b'])
    expect(batchChildIds(rows, 'self')).toEqual([])
    expect(batchChildIds(rows, 'x')).toEqual([])
  })
})
