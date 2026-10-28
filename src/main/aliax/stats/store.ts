import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Local analytics store, ported from Aliax (src/main/stats/store.ts). Everything
 * here is derived from files already on this machine (the CLIs' own session
 * logs) plus the shared usage polling, so it can be deleted and rebuilt at any
 * time.
 *
 * The database lives in temp-code's own userData, never in Aliax's: two apps
 * indexing into one file would double every row and fight over the write
 * lock. When Aliax has a stats.db and we have none yet, its file is copied
 * once as the seed, so months of usage history and every indexed log carry
 * over and the first index only reads what is new since.
 *
 * Opened by the stats engine (statsEngine.ts) inside the stats worker; the
 * main process never opens it (CLAUDE.md "Stats off the loop"). Every
 * function here takes the connection it works on.
 */
const FILES = ['stats.db', 'stats.db-wal', 'stats.db-shm']

/** Copies Aliax's stats.db (with its WAL files) beside `dest` once, when
 *  `dest` does not exist yet; a copy taken mid-write can be torn, and a torn
 *  seed is thrown away so the indexer rebuilds from the logs instead. */
export function seedFromAliax(dest: string, seedDir: string | null | undefined): void {
  if (!seedDir) return
  const src = join(seedDir, 'stats.db')
  if (existsSync(dest) || !existsSync(src)) return
  const destDir = dirname(dest)
  try {
    for (const f of FILES) {
      const from = join(seedDir, f)
      if (existsSync(from)) copyFileSync(from, join(destDir, f))
    }
    const probe = new DatabaseSync(dest)
    const ok = (probe.prepare('PRAGMA quick_check').get() as { quick_check?: string })?.quick_check === 'ok'
    probe.close()
    if (!ok) throw new Error('seed failed quick_check')
  } catch {
    for (const f of FILES) rmSync(join(destDir, f), { force: true })
  }
}

export const STATS_SCHEMA = `
    PRAGMA journal_mode = WAL;

    -- One row per assistant turn. Tokens are the raw counters the CLI recorded.
    CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY,
      service TEXT NOT NULL,
      ts INTEGER NOT NULL,
      session TEXT,
      project TEXT,
      branch TEXT,
      model TEXT,
      surface TEXT,          -- Claude 'entrypoint': cli / sdk-ts / claude-desktop / …
      effort TEXT,
      input INTEGER DEFAULT 0,
      output INTEGER DEFAULT 0,
      cache_read INTEGER DEFAULT 0,
      cache_write INTEGER DEFAULT 0,
      eph_1h INTEGER DEFAULT 0,
      eph_5m INTEGER DEFAULT 0,
      stop_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS turns_ts ON turns(ts);
    CREATE INDEX IF NOT EXISTS turns_service_ts ON turns(service, ts);

    -- Tool invocations, one row each.
    CREATE TABLE IF NOT EXISTS tool_calls (
      id INTEGER PRIMARY KEY,
      service TEXT NOT NULL,
      ts INTEGER NOT NULL,
      session TEXT,
      name TEXT NOT NULL,
      kind TEXT              -- builtin | mcp | skill
    );
    CREATE INDEX IF NOT EXISTS tool_ts ON tool_calls(ts);

    -- Notable session events: compaction, aborted turn, limit hit.
    CREATE TABLE IF NOT EXISTS session_events (
      id INTEGER PRIMARY KEY,
      service TEXT NOT NULL,
      ts INTEGER NOT NULL,
      session TEXT,
      kind TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ev_ts ON session_events(ts);

    -- Rate-limit observations. Backfilled from Codex logs, appended by our polling.
    CREATE TABLE IF NOT EXISTS usage_samples (
      id INTEGER PRIMARY KEY,
      service TEXT NOT NULL,
      account TEXT,
      ts INTEGER NOT NULL,
      label TEXT NOT NULL,
      used_percent REAL NOT NULL,
      resets_at INTEGER,
      period_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS usage_ts ON usage_samples(service, label, ts);

    -- Aliax's own actions, so switch behaviour is measurable.
    CREATE TABLE IF NOT EXISTS app_events (
      id INTEGER PRIMARY KEY,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,    -- switch | add | switch_failed | limit_hit
      service TEXT,
      account TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS app_ts ON app_events(ts);

    -- How far each source file has been read, so indexing is incremental.
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL,
      offset INTEGER NOT NULL
    );
`

/** Opens (and creates) the stats database at `path`, seeded from Aliax's
 *  copy under `seedDir` when `path` is new. The busy timeout covers the one
 *  moment a poll's sample insert meets the indexer's transaction. */
export function openStatsDb(path: string, seedDir?: string | null): DatabaseSync {
  seedFromAliax(path, seedDir)
  const db = new DatabaseSync(path, { timeout: 5_000 })
  db.exec(STATS_SCHEMA)
  return db
}

export function recordAppEvent(
  db: DatabaseSync,
  kind: string,
  service?: string,
  account?: string,
  detail?: string
): void {
  try {
    db
      .prepare('INSERT INTO app_events (ts, kind, service, account, detail) VALUES (?,?,?,?,?)')
      .run(Date.now(), kind, service ?? null, account ?? null, detail ?? null)
  } catch {
    // analytics must never break a switch
  }
}

/** Append a live usage reading, de-duplicated by (service, account, label,
 *  minute); true when a row landed. */
export function recordUsage(
  db: DatabaseSync,
  service: string,
  account: string,
  label: string,
  usedPercent: number,
  resetsAt?: number,
  periodMs?: number,
  now = Date.now()
): boolean {
  try {
    const minute = Math.floor(now / 60_000) * 60_000
    const dup = db
      .prepare(
        'SELECT 1 FROM usage_samples WHERE service=? AND account=? AND label=? AND ts=? LIMIT 1'
      )
      .get(service, account, label, minute)
    if (dup) return false
    db.prepare(
      'INSERT INTO usage_samples (service, account, ts, label, used_percent, resets_at, period_ms) VALUES (?,?,?,?,?,?,?)'
    ).run(service, account, minute, label, usedPercent, resetsAt ?? null, periodMs ?? null)
    return true
  } catch {
    return false
  }
}
