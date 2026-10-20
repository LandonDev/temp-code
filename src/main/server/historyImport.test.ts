import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from './db'
import {
  IMPORT_RECORD_KEY,
  coldPathFor,
  formatReport,
  importHistory,
  parseMapping,
  remapper,
  writerAlive,
  type HistoryMapping
} from './historyImport'

const MAPPING: HistoryMapping = {
  roots: { '/Users/me/IdeaProjects/app': '/srv/work/app', '/Users/me/Sites/web': '/srv/work/web' },
  prefixes: { '/Users/me/.temp-code/worktrees': '/srv/home/.temp-code/worktrees', '/Users/me': '/srv/home' }
}

let root: string
let from: string
let into: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'history-import-'))
  from = join(root, 'from')
  into = join(root, 'into')
  mkdirSync(from)
  mkdirSync(into)
  // openDb creates the app's schema (and the cold file) on both sides.
  openDb(join(from, 'temp-code.db')).close()
  openDb(join(into, 'temp-code.db')).close()
})
afterEach(() => rm(root, { recursive: true, force: true }))

const open = (dir: string): DatabaseSync => {
  const db = new DatabaseSync(join(dir, 'temp-code.db'))
  db.prepare('ATTACH DATABASE ? AS cold').run(coldPathFor(join(dir, 'temp-code.db')))
  return db
}
const now = 1_700_000_000_000
function workspace(db: DatabaseSync, id: string, path: string): void {
  db.prepare('INSERT INTO workspaces (id, name, path, git, created_at) VALUES (?, ?, ?, 1, ?)').run(id, id, path, now)
}
function project(db: DatabaseSync, id: string, workspaceId: string, cwd: string, mode = 'local'): void {
  db.prepare('INSERT INTO projects (id, workspace_id, name, mode, branch, cwd, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?)').run(
    id,
    workspaceId,
    id,
    mode,
    cwd,
    now
  )
}
function session(
  db: DatabaseSync,
  id: string,
  cwd: string,
  extra: { projectId?: string; workspaceId?: string; planPath?: string; archived?: number; cold?: number } = {}
): void {
  db.prepare(
    `INSERT INTO sessions (id, parent_id, provider, model, reasoning, agent_type, title, cwd, status, created_at, updated_at,
       project_id, workspace_id, plan_path, archived, cold)
     VALUES (?, NULL, 'claude', 'claude-haiku-5-5', 'low', 'implementer', ?, ?, 'idle', ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, id, cwd, now, now, extra.projectId ?? null, extra.workspaceId ?? null, extra.planPath ?? null, extra.archived ?? 0, extra.cold ?? 0)
}
function events(db: DatabaseSync, sessionId: string, n: number, schema: 'main' | 'cold'): void {
  const stmt = db.prepare(`INSERT INTO ${schema}.events (session_id, seq, ts, payload) VALUES (?, ?, ?, ?)`)
  for (let seq = 1; seq <= n; seq++) stmt.run(sessionId, seq, now + seq, JSON.stringify({ type: 'text', seq }))
}
const setting = (db: DatabaseSync, key: string, value: string): void => {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
}
const one = <T>(db: DatabaseSync, sql: string, ...params: (string | number)[]): T => db.prepare(sql).get(...params) as T
const n = (db: DatabaseSync, sql: string): number => Number((db.prepare(sql).get() as { n: number }).n)

/** A source like the Mac's: two mapped roots, one unmapped, a worktree project, a home thread. */
function seedSource(): void {
  const db = open(from)
  workspace(db, 'ws-app', '/Users/me/IdeaProjects/app')
  workspace(db, 'ws-web', '/Users/me/Sites/web')
  workspace(db, 'ws-mac', '/Users/me/Sites/mac-only')
  project(db, 'p-app', 'ws-app', '/Users/me/IdeaProjects/app')
  project(db, 'p-wt', 'ws-app', '/Users/me/.temp-code/worktrees/feature', 'worktree')
  project(db, 'p-web', 'ws-web', '/Users/me/Sites/web')
  project(db, 'p-mac', 'ws-mac', '/Users/me/Sites/mac-only')
  session(db, 's-app', '/Users/me/IdeaProjects/app', { projectId: 'p-app', planPath: '/Users/me/IdeaProjects/app/.temp-code/plan-1.md' })
  session(db, 's-wt', '/Users/me/.temp-code/worktrees/feature', { projectId: 'p-wt', planPath: '.temp-code/plan-2.md' })
  session(db, 's-web-cold', '/Users/me/Sites/web/packages/ui', { projectId: 'p-web', archived: 1, cold: 1 })
  session(db, 's-mac', '/Users/me/Sites/mac-only', { projectId: 'p-mac' })
  session(db, 's-home', '/Users/me', {})
  events(db, 's-app', 3, 'main')
  events(db, 's-wt', 2, 'main')
  events(db, 's-web-cold', 5, 'cold')
  events(db, 's-mac', 1, 'main')
  events(db, 's-home', 1, 'main')
  // An orphan event row and an orphan fold, as the real copy has.
  events(db, 's-gone', 2, 'main')
  db.prepare('INSERT INTO session_folds (session_id, folded_seq, fold_version) VALUES (?, 3, 1)').run('s-app')
  db.prepare('INSERT INTO session_folds (session_id, folded_seq, fold_version) VALUES (?, 1, 1)').run('s-gone')
  setting(db, 'thread-defaults', '{"model":"x"}')
  setting(db, 'orchestration-rules:ws-web', '{"max":4}')
  setting(db, 'turn-pass:project:p-app', '{"n":1}')
  setting(db, 'renderer.workspaceSnapshot.v1', '{"open":["s-app"]}')
  setting(db, 'github.inbox.auth', 'SECRET')
  setting(db, 'remote.publicOrigin', 'https://mac.example')
  setting(db, 'codex.speedTiers', '{}')
  db.close()
  mkdirSync(join(from, 'checkpoints', 's-app', 'files'), { recursive: true })
  writeFileSync(join(from, 'checkpoints', 's-app', 'manifest.json'), JSON.stringify({ cwd: '/Users/me/IdeaProjects/app', files: {} }))
  writeFileSync(join(from, 'checkpoints', 's-app', 'files', 'a.txt'), 'a')
  mkdirSync(join(from, 'checkpoints', 's-mac'), { recursive: true })
  writeFileSync(join(from, 'checkpoints', 's-mac', 'manifest.json'), JSON.stringify({ cwd: '/Users/me/Sites/mac-only', files: {} }))
  mkdirSync(join(from, 'html-renders', 's-app'), { recursive: true })
  writeFileSync(join(from, 'html-renders', 's-app', 'page.html'), '<p>hi</p>')
}

describe('remapper', () => {
  it('maps roots, then the longest prefix, and leaves the rest alone', () => {
    const r = remapper(MAPPING)
    expect(r.path('/Users/me/IdeaProjects/app')).toBe('/srv/work/app')
    expect(r.path('/Users/me/IdeaProjects/app/src/x.ts')).toBe('/srv/work/app/src/x.ts')
    expect(r.path('/Users/me/IdeaProjects/app-two')).toBe('/srv/home/IdeaProjects/app-two')
    expect(r.path('/Users/me/.temp-code/worktrees/f')).toBe('/srv/home/.temp-code/worktrees/f')
    expect(r.path('/Users/me')).toBe('/srv/home')
    expect(r.path('/opt/elsewhere')).toBe('/opt/elsewhere')
    expect(r.path('.temp-code/plan.md')).toBe('.temp-code/plan.md')
    expect(r.isRoot('/Users/me/Sites/web/')).toBe(true)
    expect(r.isRoot('/Users/me/Sites/web/sub')).toBe(false)
  })
  it('maps from and to filesystem roots and normalizes slashes', () => {
    const fromRoot = remapper(parseMapping(JSON.stringify({ roots: { '//': '/srv//' } })))
    expect(fromRoot.path('/')).toBe('/srv')
    expect(fromRoot.path('/a//b/')).toBe('/srv/a/b')
    expect(fromRoot.isRoot('//')).toBe(true)
    const toRoot = remapper({ roots: { '/src/': '/' }, prefixes: {} })
    expect(toRoot.path('/src')).toBe('/')
    expect(toRoot.path('/src/a//b')).toBe('/a/b')
    expect(toRoot.path('/src-other')).toBe('/src-other')
  })
  it('parses a mapping file and refuses relative paths', () => {
    const m = parseMapping(JSON.stringify({ roots: { '/a/': '/b' }, prefixes: {} }))
    expect(m.roots).toEqual({ '/a': '/b' })
    expect(() => parseMapping(JSON.stringify({ roots: { a: '/b' } }))).toThrow(/absolute/)
  })
})

describe('importHistory', () => {
  it('dry run reports the adds and changes nothing', () => {
    seedSource()
    const report = importHistory({ from, into, mapping: MAPPING, dryRun: true })
    const adds = Object.fromEntries(report.counts.map((c) => [c.table, c.add]))
    expect(adds).toEqual({
      workspaces: 3,
      projects: 4,
      sessions: 5,
      events: 7,
      'cold.events': 5,
      session_folds: 1,
      notes: 0,
      settings: 4
    })
    expect(report.missingRoots).toEqual({ '/Users/me/Sites/mac-only': 1 })
    expect(report.files).toEqual({ checkpoints: 2, htmlRenders: 1 })
    const dst = open(into)
    expect(n(dst, 'SELECT count(*) AS n FROM sessions')).toBe(0)
    dst.close()
    expect(existsSync(join(into, 'checkpoints'))).toBe(false)
    expect(formatReport(report)).toContain('DRY RUN')
  })

  it('imports with remapped paths, archives threads under a missing root, keeps identity rows out', () => {
    seedSource()
    const dst0 = open(into)
    setting(dst0, 'remote.publicOrigin', 'https://box.example')
    setting(dst0, 'thread-defaults', '{"model":"box"}')
    dst0.close()
    const report = importHistory({ from, into, mapping: MAPPING, coldBatch: 1 })
    const dst = open(into)
    expect(one<{ path: string }>(dst, 'SELECT path FROM workspaces WHERE id = ?', 'ws-app').path).toBe('/srv/work/app')
    expect(one<{ path: string }>(dst, 'SELECT path FROM workspaces WHERE id = ?', 'ws-mac').path).toBe('/Users/me/Sites/mac-only')
    expect(one<{ cwd: string; archived: number }>(dst, 'SELECT cwd, archived FROM projects WHERE id = ?', 'p-wt')).toEqual({
      cwd: '/srv/home/.temp-code/worktrees/feature',
      archived: 0
    })
    expect(one<{ cwd: string; archived: number }>(dst, 'SELECT cwd, archived FROM projects WHERE id = ?', 'p-mac')).toEqual({
      cwd: '/Users/me/Sites/mac-only',
      archived: 1
    })
    expect(one<{ cwd: string; plan_path: string }>(dst, 'SELECT cwd, plan_path FROM sessions WHERE id = ?', 's-app')).toEqual({
      cwd: '/srv/work/app',
      plan_path: '/srv/work/app/.temp-code/plan-1.md'
    })
    expect(one<{ plan_path: string }>(dst, 'SELECT plan_path FROM sessions WHERE id = ?', 's-wt').plan_path).toBe('.temp-code/plan-2.md')
    expect(one<{ cwd: string }>(dst, 'SELECT cwd FROM sessions WHERE id = ?', 's-web-cold').cwd).toBe('/srv/work/web/packages/ui')
    expect(one<{ cwd: string; archived: number }>(dst, 'SELECT cwd, archived FROM sessions WHERE id = ?', 's-mac')).toEqual({
      cwd: '/Users/me/Sites/mac-only',
      archived: 1
    })
    expect(one<{ cwd: string }>(dst, 'SELECT cwd FROM sessions WHERE id = ?', 's-home').cwd).toBe('/srv/home')
    // Hot rows in the hot file, cold rows in the cold file, orphans skipped.
    expect(n(dst, 'SELECT count(*) AS n FROM main.events')).toBe(7)
    expect(n(dst, 'SELECT count(*) AS n FROM cold.events WHERE session_id = \'s-web-cold\'')).toBe(5)
    expect(n(dst, 'SELECT count(*) AS n FROM main.events WHERE session_id = \'s-gone\'')).toBe(0)
    expect(n(dst, 'SELECT count(*) AS n FROM session_folds')).toBe(1)
    // Settings: thread rows travel, the destination's own win, machine rows never cross.
    expect(one<{ value: string }>(dst, 'SELECT value FROM settings WHERE key = ?', 'thread-defaults').value).toBe('{"model":"box"}')
    expect(one<{ value: string }>(dst, 'SELECT value FROM settings WHERE key = ?', 'orchestration-rules:ws-web').value).toBe('{"max":4}')
    expect(one<{ value: string }>(dst, 'SELECT value FROM settings WHERE key = ?', 'turn-pass:project:p-app').value).toBe('{"n":1}')
    expect(one<{ value: string }>(dst, 'SELECT value FROM settings WHERE key = ?', 'renderer.workspaceSnapshot.v1').value).toBe('{"open":["s-app"]}')
    expect(one<{ value: string }>(dst, 'SELECT value FROM settings WHERE key = ?', 'remote.publicOrigin').value).toBe('https://box.example')
    expect(dst.prepare('SELECT 1 FROM settings WHERE key IN (?, ?)').all('github.inbox.auth', 'codex.speedTiers')).toEqual([])
    const record = JSON.parse(one<{ value: string }>(dst, 'SELECT value FROM settings WHERE key = ?', IMPORT_RECORD_KEY).value)
    expect(record.missingRoots).toEqual({ '/Users/me/Sites/mac-only': 1 })
    expect(record.counts.sessions).toBe(5)
    dst.close()
    // Files: copied, the mapped manifest rewritten, the unmapped one kept.
    expect(JSON.parse(readFileSync(join(into, 'checkpoints', 's-app', 'manifest.json'), 'utf8')).cwd).toBe('/srv/work/app')
    expect(readFileSync(join(into, 'checkpoints', 's-app', 'files', 'a.txt'), 'utf8')).toBe('a')
    expect(JSON.parse(readFileSync(join(into, 'checkpoints', 's-mac', 'manifest.json'), 'utf8')).cwd).toBe('/Users/me/Sites/mac-only')
    expect(readFileSync(join(into, 'html-renders', 's-app', 'page.html'), 'utf8')).toBe('<p>hi</p>')
    expect(report.files).toEqual({ checkpoints: 2, htmlRenders: 1 })
    expect(report.counts.find((c) => c.table === 'cold.events')).toEqual({ table: 'cold.events', have: 0, add: 5 })
  })

  it('is idempotent: a second run adds nothing', () => {
    seedSource()
    importHistory({ from, into, mapping: MAPPING })
    const again = importHistory({ from, into, mapping: MAPPING, dryRun: true })
    expect(again.counts.every((c) => c.add === 0)).toBe(true)
    expect(again.files).toEqual({ checkpoints: 0, htmlRenders: 0 })
    const real = importHistory({ from, into, mapping: MAPPING })
    expect(real.counts.every((c) => c.add === 0)).toBe(true)
  })

  it('folds a workspace into the destination row that already owns its mapped path', () => {
    seedSource()
    const dst0 = open(into)
    workspace(dst0, 'box-app', '/srv/work/app')
    setting(dst0, 'orchestration-rules:box-app', '{"max":1}')
    dst0.close()
    const report = importHistory({ from, into, mapping: MAPPING })
    expect(report.workspaceAliases).toEqual({ 'ws-app': 'box-app' })
    const dst = open(into)
    expect(dst.prepare('SELECT 1 FROM workspaces WHERE id = ?').get('ws-app')).toBeUndefined()
    expect(one<{ workspace_id: string }>(dst, 'SELECT workspace_id FROM projects WHERE id = ?', 'p-app').workspace_id).toBe('box-app')
    expect(one<{ workspace_id: string }>(dst, 'SELECT workspace_id FROM projects WHERE id = ?', 'p-wt').workspace_id).toBe('box-app')
    expect(one<{ value: string }>(dst, 'SELECT value FROM settings WHERE key = ?', 'orchestration-rules:box-app').value).toBe('{"max":1}')
    dst.close()
  })

  it.each([5, 7])('fills cold seq holes even with %i destination rows', (size) => {
    seedSource()
    const dst = open(into)
    session(dst, 's-web-cold', '/srv/work/web', { cold: 1 })
    events(dst, 's-web-cold', size, 'cold')
    dst.exec("UPDATE cold.events SET seq = 99 WHERE session_id = 's-web-cold' AND seq = 3")
    dst.close()
    const dry = importHistory({ from, into, mapping: MAPPING, dryRun: true })
    expect(dry.counts.find((c) => c.table === 'cold.events')?.add).toBe(1)
    const real = importHistory({ from, into, mapping: MAPPING })
    expect(real.counts.find((c) => c.table === 'cold.events')?.add).toBe(1)
    const result = open(into)
    expect(
      n(
        result,
        "SELECT count(*) AS n FROM cold.events WHERE session_id = 's-web-cold' AND seq BETWEEN 1 AND 5"
      )
    ).toBe(5)
    result.close()
    expect(
      importHistory({ from, into, mapping: MAPPING, dryRun: true }).counts.every((c) => c.add === 0)
    ).toBe(true)
  })

  it('checks both destination tiers before adding an event', () => {
    seedSource()
    const dst = open(into)
    session(dst, 's-app', '/srv/work/app', { cold: 1 })
    events(dst, 's-app', 3, 'cold')
    session(dst, 's-web-cold', '/srv/work/web')
    events(dst, 's-web-cold', 5, 'main')
    dst.close()
    const report = importHistory({ from, into, mapping: MAPPING })
    expect(report.counts.find((c) => c.table === 'events')?.add).toBe(4)
    expect(report.counts.find((c) => c.table === 'cold.events')?.add).toBe(0)
    const result = open(into)
    expect(n(result, "SELECT count(*) AS n FROM main.events WHERE session_id = 's-app'")).toBe(0)
    expect(n(result, "SELECT count(*) AS n FROM cold.events WHERE session_id = 's-web-cold'")).toBe(
      0
    )
    result.close()
  })

  it('pins the source cold snapshot across destination commits', () => {
    seedSource()
    let changed = false
    importHistory({
      from,
      into,
      mapping: MAPPING,
      log: (line) => {
        if (!line.startsWith('metadata')) return
        const src = open(from)
        src.exec("DELETE FROM cold.events WHERE session_id = 's-web-cold' AND seq = 3")
        src.close()
        changed = true
      }
    })
    expect(changed).toBe(true)
    const dst = open(into)
    expect(n(dst, "SELECT count(*) AS n FROM cold.events WHERE session_id = 's-web-cold'")).toBe(5)
    dst.close()
  })

  it.each(['server.json', 'SingletonLock'])('refuses a live source with %s', (marker) => {
    seedSource()
    if (marker === 'server.json')
      writeFileSync(join(from, marker), JSON.stringify({ pid: process.pid }))
    else symlinkSync(`${hostname()}-${process.pid}`, join(from, marker))
    expect(() => importHistory({ from, into, mapping: MAPPING, dryRun: true })).toThrow(
      /offline source snapshots/
    )
    expect(() => importHistory({ from, into, mapping: MAPPING })).toThrow(/still open by a writer/)
    const dst = open(into)
    expect(n(dst, 'SELECT count(*) AS n FROM sessions')).toBe(0)
    dst.close()
  })

  it('refuses a destination that a running host still writes', () => {
    seedSource()
    writeFileSync(join(into, 'server.json'), JSON.stringify({ port: 1, pid: process.pid }))
    expect(writerAlive(into)).toMatch(/running/)
    expect(() => importHistory({ from, into, mapping: MAPPING, dryRun: true })).toThrow(/still open by a writer/)
    writeFileSync(join(into, 'server.json'), JSON.stringify({ port: 1, pid: 2_147_483_000 }))
    expect(writerAlive(into)).toBeNull()
    symlinkSync(`${hostname()}-${process.pid}`, join(into, 'SingletonLock'))
    expect(writerAlive(into)).toMatch(/SingletonLock/)
  })
})
