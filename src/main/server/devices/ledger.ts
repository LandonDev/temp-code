import type { DatabaseSync } from 'node:sqlite'
import type { HolderRow } from './hostDevices'

/**
 * The simulator rows of the thread-resources ledger (`thread_resources`,
 * src/main/server/threadResources.ts when that thread has landed): the
 * live rows (no removed_at) whose resource lives on `environmentId`. A
 * database without the table (an older build, or a tree where the ledger
 * is not merged yet) answers none, so every device shows "—" as its holder.
 */
export function readSimulatorHolders(db: DatabaseSync, environmentId: string): HolderRow[] {
  try {
    const has = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'thread_resources'`)
      .get()
    if (!has) return []
    const rows = db
      .prepare(
        `SELECT session_id, identifier, label FROM thread_resources
         WHERE kind = 'simulator' AND removed_at IS NULL AND environment_id = ?
         ORDER BY created_at DESC`
      )
      .all(environmentId) as unknown as { session_id: string; identifier: string; label: string }[]
    return rows.map((r) => ({ sessionId: r.session_id, identifier: r.identifier, label: r.label }))
  } catch {
    return []
  }
}
