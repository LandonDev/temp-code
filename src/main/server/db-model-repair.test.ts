import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDb, Store } from './db'

const dir = mkdtempSync(join(tmpdir(), 'tc-model-repair-'))
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('openDb repairs model ids', () => {
  it('a row holding a display slug reads back as the catalog id; real ids and archived rows stay', () => {
    const path = join(dir, 'app.db')
    const seed = openDb(path)
    const insert = seed.prepare(
      `INSERT INTO sessions (id, provider, model, reasoning, agent_type, title, cwd, status, archived, created_at, updated_at)
       VALUES (?, 'claude', ?, 'medium', 'implementer', ?, '/tmp', 'idle', ?, 1, 1)`
    )
    insert.run('a', 'fable-5.1', 'a', 0)
    insert.run('b', 'claude-opus-5-5', 'b', 0)
    insert.run('c', 'opus-5.5', 'c', 1)
    seed.close()

    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const db = openDb(path)
    const store = new Store(db)
    expect(store.getSession('a')?.model).toBe('claude-fable-5-1')
    expect(store.getSession('b')?.model).toBe('claude-opus-5-5')
    expect(store.getSession('c')?.model).toBe('opus-5.5')
    expect(log.mock.calls.map((c) => String(c[0]))).toEqual(['[db] session a: model fable-5.1 -> claude-fable-5-1'])
    log.mockRestore()
    db.close()
  })
})
