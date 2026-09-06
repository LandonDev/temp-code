import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb } from './db'
import { Notes } from './notes'

let db: ReturnType<typeof openDb>
let notes: Notes
beforeEach(() => {
  db = openDb(':memory:')
  notes = new Notes(db)
})
afterEach(() => {
  vi.restoreAllMocks()
  db.close()
})
describe('notes', () => {
  it('creates, reads, updates and deletes while retaining slug, source and creation time', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100)
    const first = notes.upsert({
      id: 'n1',
      title: '  Hello, world!  ',
      body: 'a\r\nb\rc',
      sourceSessionId: 's1',
      sourceCwd: ' /tmp/repo '
    })
    expect(first).toEqual({
      id: 'n1',
      title: 'Hello, world!',
      slug: 'hello-world',
      body: 'a\nb\nc',
      sourceSessionId: 's1',
      sourceCwd: '/tmp/repo',
      createdAt: 100,
      updatedAt: 100
    })
    expect(notes.get('n1')).toEqual(first)
    vi.spyOn(Date, 'now').mockReturnValue(200)
    const edited = notes.upsert({
      id: 'n1',
      title: 'Changed',
      body: 'new',
      sourceSessionId: 's2',
      sourceCwd: '/elsewhere'
    })
    expect(edited).toEqual({ ...first, title: 'Changed', body: 'new', updatedAt: 200 })
    notes.delete('n1')
    expect(notes.get('n1')).toBeNull()
    expect(notes.list()).toEqual([])
    notes.delete('n1')
  })
  it('allocates unique ASCII slugs and sorts updatedAt descending, then id ascending', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100)
    notes.upsert({ id: 'b', title: 'Same', body: '' })
    expect(notes.upsert({ id: 'a', title: 'Same', body: '' }).slug).toBe('same-2')
    expect(notes.list().map((n) => n.id)).toEqual(['a', 'b'])
    vi.spyOn(Date, 'now').mockReturnValue(200)
    notes.upsert({ id: 'b', title: 'Renamed', body: '' })
    expect(notes.list().map((n) => n.id)).toEqual(['b', 'a'])
    expect(notes.upsert({ id: 'c', title: 'Äİ***', body: '' }).slug).toBe('note')
    expect(notes.upsert({ id: 'd', title: '  ', body: '' }).title).toBe('Untitled')
  })
  it('caps titles by code points and rejects oversized UTF-8 bodies and invalid ids', () => {
    expect(
      Array.from(notes.upsert({ id: 'a', title: '😀'.repeat(201), body: '' }).title)
    ).toHaveLength(200)
    expect(
      notes.upsert({ id: 'b', title: 'x'.repeat(80), body: 'é'.repeat(500_000) }).slug
    ).toHaveLength(48)
    expect(() => notes.upsert({ id: 'b', title: 'x', body: 'é'.repeat(500_001) })).toThrow(
      'too large'
    )
    expect(() => notes.upsert({ id: '../bad', title: 'x', body: '' })).toThrow()
    expect(() => notes.get('bad id')).toThrow()
  })
})
