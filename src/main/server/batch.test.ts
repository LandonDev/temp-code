import { describe, expect, it } from 'vitest'
import type { SessionMeta } from '@shared/events'
import { handleBatch } from './batch'

const meta = (id: string, patch: Partial<SessionMeta> = {}): SessionMeta =>
  ({ id, parentId: null, archived: false, createdAt: 1, status: 'idle', ...patch }) as SessionMeta

const registry = {
  list: () => [
    meta('m'),
    meta('b', { masterId: 'm', createdAt: 3, status: 'queued' }),
    meta('a', { masterId: 'm', createdAt: 2 }),
    meta('sub', { masterId: 'm', parentId: 'a', createdAt: 4 }),
    meta('other', { masterId: 'n' })
  ]
}

describe('handleBatch', () => {
  it('batch.get answers an empty batch with the master\'s roots pending, oldest first', () => {
    const r = handleBatch({ id: '1', method: 'batch.get', params: { masterId: 'm' } }, registry)
    expect(r).toEqual({
      handled: true,
      result: {
        masterId: 'm',
        steps: [
          { id: 'land', status: 'pending', detail: '', at: null },
          { id: 'gate', status: 'pending', detail: '', at: null },
          { id: 'release', status: 'pending', detail: '', at: null }
        ],
        landed: [],
        pending: ['a', 'b']
      }
    })
  })
  it('batch.children answers the same roots as summaries', () => {
    const r = handleBatch({ id: '1', method: 'batch.children', params: { masterId: 'm' } }, registry)
    expect(r.handled && (r.result as { children: SessionMeta[] }).children.map((s) => s.id)).toEqual(['a', 'b'])
  })
  it('leaves other methods alone', () => {
    expect(handleBatch({ id: '1', method: 'session.list', params: {} } as never, registry)).toEqual({ handled: false })
  })
})
