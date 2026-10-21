import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { readSimulatorHolders } from './ledger'

describe('readSimulatorHolders', () => {
  it('a database without the ledger answers none (every holder shows "—")', () => {
    const db = new DatabaseSync(':memory:')
    expect(readSimulatorHolders(db, 'env_x')).toEqual([])
  })

  it('the live simulator rows of one Mac, newest first; removed rows and other kinds left out', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`
      CREATE TABLE thread_resources (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, environment_id TEXT NOT NULL, kind TEXT NOT NULL,
        identifier TEXT NOT NULL, label TEXT NOT NULL, branch TEXT, created_at INTEGER NOT NULL,
        remove_requested_at INTEGER, removed_at INTEGER, note TEXT
      )`)
    const insert = db.prepare(
      `INSERT INTO thread_resources (id, session_id, environment_id, kind, identifier, label, created_at, removed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    insert.run('r1', 's1', 'env_mac', 'simulator', 'AAA', 'iPhone 17 Pro', 10, null)
    insert.run('r2', 's2', 'env_mac', 'simulator', 'BBB', 'iPad', 20, null)
    insert.run('r3', 's3', 'env_mac', 'simulator', 'CCC', 'gone', 30, 31)
    insert.run('r4', 's4', 'env_mac', 'worktree', '/tmp/wt', 'wt', 40, null)
    insert.run('r5', 's5', 'env_other', 'simulator', 'DDD', 'elsewhere', 50, null)
    expect(readSimulatorHolders(db, 'env_mac')).toEqual([
      { sessionId: 's2', identifier: 'BBB', label: 'iPad' },
      { sessionId: 's1', identifier: 'AAA', label: 'iPhone 17 Pro' }
    ])
  })
})
