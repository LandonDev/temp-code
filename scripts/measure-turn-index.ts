/**
 * How long the FTS5 turn index takes to build and to answer on a real
 * database, against a COPY (never the live file):
 *
 *   cp <userData>/temp-code.db* <scratch>/ ; cp <userData>/temp-code-cold.db* <scratch>/
 *   bunx vite-node --config vitest.config.ts scripts/measure-turn-index.ts <scratch>/temp-code.db [query ...]
 *
 * Prints the table sizes, the time of the scan session.search was before
 * the index, the backfill's wall time and rows per file, the file growth,
 * and the FTS query time for each query, hot only and hot plus cold. The
 * copy is modified (the index is written into it).
 */
import { statSync } from 'node:fs'
import { openDb, Store } from '../src/main/server/db'
import { TURN_ROW_SQL } from '../src/main/server/turnIndex'

const path = process.argv[2]
if (!path) {
  console.error('usage: measure-turn-index <copy-of-temp-code.db> [query ...]')
  process.exit(2)
}
const queries = process.argv.slice(3).length ? process.argv.slice(3) : ['gateway', 'session move', 'notarize', 'the', 'fts5']
const cold = path.replace(/\.db$/, '') + '-cold.db'
const size = (p: string): number => {
  try {
    return statSync(p).size
  } catch {
    return 0
  }
}
const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(0)} MB`
const ms = (n: number): string => `${n.toFixed(0)} ms`

const db = openDb(path)
const store = new Store(db)
const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n

console.log(`hot ${mb(size(path))} (+wal ${mb(size(path + '-wal'))}), cold ${mb(size(cold))} (+wal ${mb(size(cold + '-wal'))})`)
console.log(`sessions ${count('SELECT count(*) AS n FROM sessions')}, hot rows ${count('SELECT count(*) AS n FROM events')}, cold rows ${count('SELECT count(*) AS n FROM cold.events')}`)
console.log(`turn rows: hot ${count(`SELECT count(*) AS n FROM events e WHERE ${TURN_ROW_SQL}`)}, cold ${count(`SELECT count(*) AS n FROM cold.events e WHERE ${TURN_ROW_SQL}`)}`)
console.log(`FTS5 available: ${store.turnIndex.available}; pending sessions ${store.turnIndex.pending().length}`)

// The scan the search was before the index (db.ts before this change).
const scanSql = (table: string): string =>
  `SELECT e.session_id AS sessionId, e.seq AS seq, e.ts AS ts,
          json_extract(e.payload, '$.type') AS type,
          substr(json_extract(e.payload, '$.text'),
                 max(1, instr(lower(json_extract(e.payload, '$.text')), ?) - 60), 180) AS snippet
   FROM ${table} e JOIN sessions s ON s.id = e.session_id
   WHERE json_extract(e.payload, '$.type') IN ('user-text', 'assistant-text')
     AND COALESCE(json_extract(e.payload, '$.delta'), 0) = 0
     AND json_extract(e.payload, '$.parentCallId') IS NULL
     AND instr(lower(json_extract(e.payload, '$.text')), ?) > 0`
const timeScan = (archived: boolean, q: string): { ms: number; rows: number } => {
  const needle = q.toLowerCase()
  const sql = `${scanSql('events')} ${archived ? `UNION ALL ${scanSql('cold.events')}` : ''} ORDER BY ts DESC, seq DESC LIMIT 201`
  const params = archived ? [needle, needle, needle, needle] : [needle, needle]
  const t = performance.now()
  const rows = db.prepare(sql).all(...params).length
  return { ms: performance.now() - t, rows }
}

console.log('\nscan (before the index):')
for (const q of queries) {
  const hot = timeScan(false, q)
  const all = timeScan(true, q)
  console.log(`  ${JSON.stringify(q).padEnd(16)} hot ${ms(hot.ms).padStart(9)} (${hot.rows} rows)   hot+cold ${ms(all.ms).padStart(9)} (${all.rows} rows)`)
}

console.log('\nbackfill:')
const before = { hot: size(path) + size(path + '-wal'), cold: size(cold) + size(cold + '-wal') }
let sessions = 0
let rows = 0
const t0 = performance.now()
await store.backfillTurnIndex({
  onProgress: (p) => {
    sessions += 1
    rows += p.rows
  }
})
const wall = performance.now() - t0
db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA cold.wal_checkpoint(TRUNCATE)')
const after = { hot: size(path) + size(path + '-wal'), cold: size(cold) + size(cold + '-wal') }
console.log(`  ${sessions} sessions, ${rows} text rows in ${(wall / 1000).toFixed(1)} s (${(rows / (wall / 1000)).toFixed(0)} rows/s)`)
console.log(`  fts rows: hot ${count('SELECT count(*) AS n FROM events_fts')}, cold ${count('SELECT count(*) AS n FROM cold.events_fts')}`)
console.log(`  file growth: hot +${mb(after.hot - before.hot)}, cold +${mb(after.cold - before.cold)}`)

console.log('\nFTS query (session.search after the index):')
for (const q of queries) {
  // Warm once so the page cache is comparable to the scan's second run.
  await store.searchEvents({ query: q })
  const t1 = performance.now()
  const hot = await store.searchEvents({ query: q })
  const hotMs = performance.now() - t1
  const t2 = performance.now()
  const all = await store.searchEvents({ query: q, archived: true })
  const allMs = performance.now() - t2
  console.log(`  ${JSON.stringify(q).padEnd(16)} hot ${ms(hotMs).padStart(9)} (${hot.hits.length} rows)   hot+cold ${ms(allMs).padStart(9)} (${all.hits.length} rows)`)
}
db.close()
