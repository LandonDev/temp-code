import { cpSync, existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * Moves one host's thread history into another host's database
 * (docs/history-move.md). Node builtins only, and no repo imports, so the
 * box runs it straight from a checkout with `node src/main/server/
 * historyImport.ts` (node 22 strips the types); the test suite exercises
 * the same functions.
 *
 * History is workspaces, projects, sessions, events (hot and cold), folds,
 * notes, the settings rows about threads, and the per-session dirs
 * (checkpoints, html-renders). The destination's own identity never
 * changes: remote keys, pairings, browser sessions, `remote.*` settings
 * and `environment.json` are not read, let alone written.
 *
 * Every insert is OR IGNORE by primary key, so a rerun adds nothing, and
 * `dryRun` reports what a run would add without touching anything.
 */

export interface HistoryMapping {
  /** Workspace roots that exist (or will) on the destination: source path → destination path. */
  roots: Record<string, string>
  /** Fallbacks for paths outside a mapped root (app worktrees, the home dir), longest match wins. */
  prefixes: Record<string, string>
}

export interface ImportOptions {
  /** Dir holding `temp-code.db`, `temp-code-cold.db`, `checkpoints/`, `html-renders/` of the source. */
  from: string
  /** The destination userData dir; its database must already have the app's schema. */
  into: string
  mapping: HistoryMapping
  dryRun?: boolean
  /** Copy the per-session dirs too (default true). */
  files?: boolean
  /** Where the history came from, kept in the `history.import` settings row. */
  label?: string
  /** Sessions per cold-events transaction (default 200). */
  coldBatch?: number
  log?: (line: string) => void
}

export interface TableCount {
  table: string
  have: number
  add: number
}

export interface ImportReport {
  dryRun: boolean
  counts: TableCount[]
  /** Source workspace roots with no mapping, with the threads imported archived under them. */
  missingRoots: Record<string, number>
  /** Source workspace ids folded into a destination workspace that already owned the mapped path. */
  workspaceAliases: Record<string, string>
  files: { checkpoints: number; htmlRenders: number }
}

export const IMPORT_RECORD_KEY = 'history.import'
const SNAPSHOT_KEY = 'renderer.workspaceSnapshot.v1'
/** Settings that describe the user's threads rather than the machine. */
const SETTINGS_ALLOW = [/^orchestration-rules(:|$)/, /^thread-defaults(:|$)/, /^turn-pass:/, /^build:/]
const WORKSPACE_SUFFIXED = /^(orchestration-rules|thread-defaults|turn-pass|build):([^:]+)$/

type Row = Record<string, string | number | null>

/** `temp-code.db` → `temp-code-cold.db`, the same rule as db.ts. */
export const coldPathFor = (path: string): string => path.replace(/\.db$/, '') + '-cold.db'

const stripSlash = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path)

export function parseMapping(raw: string): HistoryMapping {
  const parsed = JSON.parse(raw) as Partial<HistoryMapping>
  const clean = (table: unknown): Record<string, string> => {
    const out: Record<string, string> = {}
    if (table && typeof table === 'object') {
      for (const [from, to] of Object.entries(table as Record<string, unknown>)) {
        if (typeof to !== 'string' || !isAbsolute(from) || !isAbsolute(to)) throw new Error(`mapping: ${from} → ${String(to)} must be two absolute paths`)
        out[stripSlash(from)] = stripSlash(to)
      }
    }
    return out
  }
  return { roots: clean(parsed.roots), prefixes: clean(parsed.prefixes) }
}

export interface Remapper {
  /** True when the path is a mapped workspace root. */
  isRoot(path: string): boolean
  /** The path on the destination: by root, else by the longest prefix, else unchanged. */
  path(path: string): string
}

export function remapper(mapping: HistoryMapping): Remapper {
  const byLength = (table: Record<string, string>): [string, string][] =>
    Object.entries(table).sort((a, b) => b[0].length - a[0].length)
  const roots = byLength(mapping.roots)
  const prefixes = byLength(mapping.prefixes)
  const under = (path: string, from: string): boolean => path === from || path.startsWith(from + '/')
  const apply = (path: string, table: [string, string][]): string | null => {
    for (const [from, to] of table) if (under(path, from)) return to + path.slice(from.length)
    return null
  }
  return {
    isRoot: (path) => stripSlash(path) in mapping.roots,
    path: (path) => {
      if (!isAbsolute(path)) return path
      const clean = stripSlash(path)
      return apply(clean, roots) ?? apply(clean, prefixes) ?? path
    }
  }
}

/** A description of the process still writing the destination, or null when none is. */
export function writerAlive(userData: string): string | null {
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM'
    }
  }
  try {
    const { pid } = JSON.parse(readFileSync(join(userData, 'server.json'), 'utf8')) as { pid?: number }
    if (typeof pid === 'number' && alive(pid)) return `server.json names pid ${pid}, which is running`
  } catch {
    /* no headless host record */
  }
  try {
    const target = readlinkSync(join(userData, 'SingletonLock'))
    const match = /^(.*)-(\d+)$/.exec(target)
    if (match && match[1] === hostname() && alive(Number(match[2]))) return `SingletonLock is held by pid ${match[2]}`
  } catch {
    /* no lock */
  }
  return null
}

function columns(db: DatabaseSync, schema: string, table: string): string[] {
  return (db.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
}

function tableExists(db: DatabaseSync, schema: string, table: string): boolean {
  return (
    db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`).get(table) !== undefined
  )
}

const count = (db: DatabaseSync, sql: string): number => Number((db.prepare(sql).get() as { n: number }).n)

export function importHistory(opts: ImportOptions): ImportReport {
  const log = opts.log ?? (() => {})
  const dryRun = opts.dryRun === true
  const files = opts.files !== false
  const remap = remapper(opts.mapping)
  const srcHot = join(opts.from, 'temp-code.db')
  const dstHot = join(opts.into, 'temp-code.db')
  for (const file of [srcHot, coldPathFor(srcHot), dstHot]) {
    if (!existsSync(file)) throw new Error(`${file}: no such database`)
  }
  const live = writerAlive(opts.into)
  if (live) throw new Error(`${opts.into} is still open by a writer (${live}); stop it first`)

  const db = new DatabaseSync(dstHot)
  try {
    db.prepare('ATTACH DATABASE ? AS dcold').run(coldPathFor(dstHot))
    db.prepare('ATTACH DATABASE ? AS shot').run(srcHot)
    db.prepare('ATTACH DATABASE ? AS scold').run(coldPathFor(srcHot))
    for (const table of ['workspaces', 'projects', 'sessions', 'events', 'session_folds', 'settings']) {
      if (!tableExists(db, 'main', table)) throw new Error(`${dstHot} has no ${table} table; start the app on it once`)
    }
    db.exec(`CREATE TABLE IF NOT EXISTS dcold.events (
      session_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY (session_id, seq))`)
    db.exec('PRAGMA main.busy_timeout = 60000')
    return run(db, { ...opts, dryRun, files, log }, remap)
  } finally {
    db.close()
  }
}

function run(db: DatabaseSync, opts: Required<Pick<ImportOptions, 'from' | 'into' | 'dryRun' | 'files' | 'log'>> & ImportOptions, remap: Remapper): ImportReport {
  const { from, into, dryRun, files, log } = opts
  const label = opts.label ?? 'mac'
  const counts: TableCount[] = []
  const have = (table: string, schema = 'main'): number => count(db, `SELECT count(*) AS n FROM ${schema}.${table}`)
  const srcRows = (table: string): Row[] => db.prepare(`SELECT * FROM shot.${table}`).all() as Row[]
  const insert = (table: string, rows: Row[]): void => {
    if (rows.length === 0) return
    const cols = columns(db, 'main', table).filter((c) => c in rows[0])
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO main.${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
    )
    for (const row of rows) stmt.run(...cols.map((c) => row[c] ?? null))
  }
  const dstIds = (table: string, column = 'id'): Set<string> =>
    new Set((db.prepare(`SELECT ${column} AS id FROM main.${table}`).all() as { id: string }[]).map((r) => r.id))

  // Workspaces: a destination workspace already owning the mapped path wins.
  const srcWorkspaces = srcRows('workspaces')
  const dstWorkspaceIds = dstIds('workspaces')
  const dstByPath = new Map(
    (db.prepare('SELECT id, path FROM main.workspaces').all() as { id: string; path: string }[]).map((w) => [stripSlash(w.path), w.id])
  )
  const workspaceAliases: Record<string, string> = {}
  const mappedWorkspace = new Map<string, boolean>()
  const workspaceRows: Row[] = []
  for (const w of srcWorkspaces) {
    const id = String(w.id)
    const mapped = remap.isRoot(String(w.path))
    mappedWorkspace.set(id, mapped)
    const path = mapped ? remap.path(String(w.path)) : String(w.path)
    if (dstWorkspaceIds.has(id)) continue
    const owner = dstByPath.get(stripSlash(path))
    if (owner && owner !== id) {
      workspaceAliases[id] = owner
      continue
    }
    workspaceRows.push({ ...w, path })
  }
  const wsId = (id: string | number | null): string | null => (id === null ? null : workspaceAliases[String(id)] ?? String(id))
  counts.push({ table: 'workspaces', have: have('workspaces'), add: workspaceRows.length })

  // Projects: paths remapped under a mapped root; archived under a missing one.
  const srcProjects = srcRows('projects')
  const projectWorkspace = new Map(srcProjects.map((p) => [String(p.id), String(p.workspace_id)]))
  const dstProjectIds = dstIds('projects')
  const projectRows: Row[] = []
  for (const p of srcProjects) {
    if (dstProjectIds.has(String(p.id))) continue
    const mapped = mappedWorkspace.get(String(p.workspace_id)) ?? false
    projectRows.push({
      ...p,
      workspace_id: wsId(p.workspace_id),
      cwd: mapped ? remap.path(String(p.cwd)) : p.cwd,
      archived: mapped ? p.archived : 1
    })
  }
  counts.push({ table: 'projects', have: have('projects'), add: projectRows.length })

  // Sessions: the workspace comes through the project when there is one.
  const srcSessions = srcRows('sessions')
  const dstSessionIds = dstIds('sessions')
  const missingRoots: Record<string, number> = {}
  const workspacePath = new Map(srcWorkspaces.map((w) => [String(w.id), String(w.path)]))
  const sessionMapped = new Map<string, boolean>()
  const sessionRows: Row[] = []
  for (const s of srcSessions) {
    const ws = s.project_id !== null ? projectWorkspace.get(String(s.project_id)) ?? null : s.workspace_id === null ? null : String(s.workspace_id)
    const mapped = ws === null ? true : mappedWorkspace.get(ws) ?? false
    sessionMapped.set(String(s.id), mapped)
    if (!mapped && ws !== null) {
      const root = workspacePath.get(ws) ?? ws
      missingRoots[root] = (missingRoots[root] ?? 0) + 1
    }
    if (dstSessionIds.has(String(s.id))) continue
    const plan = s.plan_path
    sessionRows.push({
      ...s,
      workspace_id: wsId(s.workspace_id),
      cwd: mapped ? remap.path(String(s.cwd)) : s.cwd,
      plan_path: mapped && typeof plan === 'string' && isAbsolute(plan) ? remap.path(plan) : plan,
      archived: mapped ? s.archived : 1
    })
  }
  counts.push({ table: 'sessions', have: have('sessions'), add: sessionRows.length })

  // Events: rows of known sessions, hot file to hot file and cold to cold.
  const hotAdd = count(
    db,
    `SELECT count(*) AS n FROM shot.events e
       WHERE e.session_id IN (SELECT id FROM shot.sessions)
         AND NOT EXISTS (SELECT 1 FROM main.events d WHERE d.session_id = e.session_id AND d.seq = e.seq)`
  )
  counts.push({ table: 'events', have: have('events'), add: hotAdd })
  const perSession = (schema: string): Map<string, number> =>
    new Map(
      (db.prepare(`SELECT session_id AS id, count(*) AS n FROM ${schema}.events GROUP BY session_id`).all() as {
        id: string
        n: number
      }[]).map((r) => [r.id, Number(r.n)])
    )
  const srcCold = perSession('scold')
  const dstCold = perSession('dcold')
  const srcSessionIds = new Set(srcSessions.map((s) => String(s.id)))
  const coldPending: string[] = []
  let coldAdd = 0
  for (const [id, n] of srcCold) {
    if (!srcSessionIds.has(id)) continue
    const missing = n - (dstCold.get(id) ?? 0)
    if (missing > 0) {
      coldAdd += missing
      coldPending.push(id)
    }
  }
  counts.push({ table: 'cold.events', have: have('events', 'dcold'), add: coldAdd })

  const foldsAdd = count(
    db,
    `SELECT count(*) AS n FROM shot.session_folds f
       WHERE f.session_id IN (SELECT id FROM shot.sessions)
         AND NOT EXISTS (SELECT 1 FROM main.session_folds d WHERE d.session_id = f.session_id)`
  )
  counts.push({ table: 'session_folds', have: have('session_folds'), add: foldsAdd })

  const noteRows: Row[] = []
  if (tableExists(db, 'shot', 'notes') && tableExists(db, 'main', 'notes')) {
    const dstNoteIds = dstIds('notes')
    for (const n of srcRows('notes')) {
      if (dstNoteIds.has(String(n.id))) continue
      const cwd = n.source_cwd
      noteRows.push({ ...n, source_cwd: typeof cwd === 'string' ? remap.path(cwd) : cwd })
    }
  }
  counts.push({ table: 'notes', have: tableExists(db, 'main', 'notes') ? have('notes') : 0, add: noteRows.length })

  // Settings about threads, never about the machine; the destination's own rows win.
  const dstSettingKeys = dstIds('settings', 'key')
  const settingRows: Row[] = []
  for (const row of srcRows('settings')) {
    let key = String(row.key)
    if (key === SNAPSHOT_KEY) {
      if (!dstSettingKeys.has(key)) settingRows.push(row)
      continue
    }
    if (!SETTINGS_ALLOW.some((re) => re.test(key))) continue
    const suffixed = WORKSPACE_SUFFIXED.exec(key)
    if (suffixed && workspaceAliases[suffixed[2]]) key = `${suffixed[1]}:${workspaceAliases[suffixed[2]]}`
    if (!dstSettingKeys.has(key)) settingRows.push({ ...row, key })
  }
  counts.push({ table: 'settings', have: have('settings'), add: settingRows.length })

  // Per-session dirs: copied when the destination lacks them.
  const dirsToCopy = (kind: 'checkpoints' | 'html-renders', marker: string | null): string[] =>
    [...srcSessionIds].filter((id) => {
      const src = join(from, kind, id)
      const dst = join(into, kind, id)
      return existsSync(marker ? join(src, marker) : src) && !existsSync(marker ? join(dst, marker) : dst)
    })
  const checkpointDirs = files ? dirsToCopy('checkpoints', 'manifest.json') : []
  const renderDirs = files ? dirsToCopy('html-renders', null) : []

  const report: ImportReport = {
    dryRun,
    counts,
    missingRoots,
    workspaceAliases,
    files: { checkpoints: checkpointDirs.length, htmlRenders: renderDirs.length }
  }
  if (dryRun) return report

  db.exec('BEGIN IMMEDIATE')
  try {
    insert('workspaces', workspaceRows)
    insert('projects', projectRows)
    insert('sessions', sessionRows)
    db.exec(`INSERT OR IGNORE INTO main.events (session_id, seq, ts, payload)
      SELECT session_id, seq, ts, payload FROM shot.events WHERE session_id IN (SELECT id FROM main.sessions)`)
    const foldCols = columns(db, 'main', 'session_folds').filter((c) => columns(db, 'shot', 'session_folds').includes(c))
    db.exec(`INSERT OR IGNORE INTO main.session_folds (${foldCols.join(', ')})
      SELECT ${foldCols.join(', ')} FROM shot.session_folds WHERE session_id IN (SELECT id FROM main.sessions)`)
    insert('notes', noteRows)
    insert('settings', settingRows)
    db.prepare('INSERT OR REPLACE INTO main.settings (key, value) VALUES (?, ?)').run(
      IMPORT_RECORD_KEY,
      JSON.stringify({
        at: Date.now(),
        from: label,
        counts: Object.fromEntries(counts.map((c) => [c.table, c.add])),
        missingRoots,
        workspaceAliases,
        mapping: opts.mapping
      })
    )
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  log(`metadata and hot events committed; ${coldPending.length} sessions of cold events to copy`)

  // Cold events in their own transactions, so the WAL never holds the whole file.
  const batch = Math.max(1, opts.coldBatch ?? 200)
  for (let i = 0; i < coldPending.length; i += batch) {
    const ids = coldPending.slice(i, i + batch)
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(
        `INSERT OR IGNORE INTO dcold.events (session_id, seq, ts, payload)
           SELECT session_id, seq, ts, payload FROM scold.events WHERE session_id IN (${ids.map(() => '?').join(', ')})`
      ).run(...ids)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    db.exec('PRAGMA dcold.wal_checkpoint(TRUNCATE)')
    log(`cold events: ${Math.min(i + batch, coldPending.length)}/${coldPending.length} sessions`)
  }

  for (const id of checkpointDirs) {
    copyDir(join(from, 'checkpoints', id), join(into, 'checkpoints', id))
    if (sessionMapped.get(id)) rewriteManifest(join(into, 'checkpoints', id, 'manifest.json'), remap)
  }
  for (const id of renderDirs) copyDir(join(from, 'html-renders', id), join(into, 'html-renders', id))
  if (files) log(`files: ${checkpointDirs.length} checkpoint dirs, ${renderDirs.length} html-render dirs copied`)

  // The real counts, now that the rows are in.
  for (const c of counts) {
    const schema = c.table === 'cold.events' ? 'dcold' : 'main'
    const table = c.table === 'cold.events' ? 'events' : c.table
    if (c.table === 'notes' && !tableExists(db, 'main', 'notes')) continue
    const now = have(table, schema)
    c.add = now - c.have
  }
  return report
}

/** Copy under a temp name and rename, so a half-copied dir never looks finished. */
function copyDir(src: string, dst: string): void {
  const tmp = `${dst}.importing`
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(join(dst, '..'), { recursive: true })
  cpSync(src, tmp, { recursive: true })
  renameSync(tmp, dst)
}

function rewriteManifest(path: string, remap: Remapper): void {
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { cwd?: unknown }
    if (typeof manifest.cwd !== 'string') return
    const cwd = remap.path(manifest.cwd)
    if (cwd === manifest.cwd) return
    writeFileSync(path, JSON.stringify({ ...manifest, cwd }, null, 2))
  } catch {
    /* an unreadable manifest stays as copied */
  }
}

export function formatReport(report: ImportReport): string {
  const width = Math.max(...report.counts.map((c) => c.table.length))
  const lines = [
    `${report.dryRun ? 'DRY RUN' : 'IMPORTED'}  ${'table'.padEnd(width)}  ${'have'.padStart(9)}  ${'add'.padStart(9)}  ${'after'.padStart(9)}`
  ]
  for (const c of report.counts) {
    lines.push(`         ${c.table.padEnd(width)}  ${String(c.have).padStart(9)}  ${String(c.add).padStart(9)}  ${String(c.have + c.add).padStart(9)}`)
  }
  lines.push(`files: ${report.files.checkpoints} checkpoint dirs, ${report.files.htmlRenders} html-render dirs`)
  const missing = Object.entries(report.missingRoots)
  lines.push(
    missing.length === 0
      ? 'missing roots: none'
      : `missing roots (threads imported archived, paths kept):\n${missing.map(([root, n]) => `  ${root}  ${n}`).join('\n')}`
  )
  const aliases = Object.entries(report.workspaceAliases)
  if (aliases.length > 0) lines.push(`workspace aliases:\n${aliases.map(([a, b]) => `  ${a} → ${b}`).join('\n')}`)
  return lines.join('\n')
}

function main(argv: string[]): void {
  const args = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`)
    const name = arg.slice(2)
    if (name === 'dry-run' || name === 'no-files') args.set(name, '1')
    else args.set(name, argv[++i] ?? '')
  }
  const need = (name: string): string => {
    const value = args.get(name)
    if (!value) throw new Error(`--${name} is required`)
    return value
  }
  const report = importHistory({
    from: need('from'),
    into: need('into'),
    mapping: parseMapping(readFileSync(need('map'), 'utf8')),
    dryRun: args.has('dry-run'),
    files: !args.has('no-files'),
    label: args.get('label'),
    log: (line) => console.error(line)
  })
  console.log(formatReport(report))
}

if (process.argv[1]?.endsWith('historyImport.ts')) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    console.error(`import-history: ${(err as Error).message}`)
    process.exit(1)
  }
}
