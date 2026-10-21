import { cpSync, existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
// The extension stays: the box runs this file with node, which resolves nothing on its own.
import { parseMapping, remapper, stripSlash, type HistoryMapping, type Remapper } from './pathMap.ts'

export { parseMapping, remapper, type HistoryMapping, type Remapper }

/**
 * Moves one host's thread history into another host's database
 * (docs/history-move.md). Node builtins only, and no repo imports, so the
 * box runs it straight from a checkout with `node src/main/server/
 * historyImport.ts` (node 22 strips the types); the test suite exercises
 * the same functions. Its one repo import, pathMap.ts, follows the same rule.
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

/** A description of the process still writing this data dir, or null when none is. */
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
    const { pid } = JSON.parse(readFileSync(join(userData, 'server.json'), 'utf8')) as {
      pid?: number
    }
    if (typeof pid === 'number' && alive(pid))
      return `server.json names pid ${pid}, which is running`
  } catch {
    /* no headless host record */
  }
  try {
    const target = readlinkSync(join(userData, 'SingletonLock'))
    const match = /^(.*)-(\d+)$/.exec(target)
    if (match && match[1] === hostname() && alive(Number(match[2])))
      return `SingletonLock is held by pid ${match[2]}`
  } catch {
    /* no lock */
  }
  return null
}

function columns(db: DatabaseSync, schema: string, table: string): string[] {
  return (db.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as { name: string }[]).map(
    (c) => c.name
  )
}

function tableExists(db: DatabaseSync, schema: string, table: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table) !== undefined
  )
}

const count = (db: DatabaseSync, sql: string): number =>
  Number((db.prepare(sql).get() as { n: number }).n)

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
  for (const dir of [opts.from, opts.into]) {
    const live = writerAlive(dir)
    if (live)
      throw new Error(
        `${dir} is still open by a writer (${live}); stop it first; use offline source snapshots`
      )
  }

  const db = new DatabaseSync(dstHot)
  const source = new DatabaseSync(srcHot, { readOnly: true })
  try {
    source.prepare('ATTACH DATABASE ? AS scold').run(coldPathFor(srcHot))
    source.exec('PRAGMA busy_timeout = 60000; PRAGMA query_only = ON; BEGIN')
    // Pin both source snapshots before reading metadata. Keep them through
    // every destination batch commit; never follow a moving hot/cold source.
    source.prepare('SELECT count(*) FROM main.sqlite_master').get()
    source.prepare('SELECT count(*) FROM scold.sqlite_master').get()
    db.prepare('ATTACH DATABASE ? AS dcold').run(coldPathFor(dstHot))
    for (const table of [
      'workspaces',
      'projects',
      'sessions',
      'events',
      'session_folds',
      'settings'
    ]) {
      if (!tableExists(db, 'main', table))
        throw new Error(`${dstHot} has no ${table} table; start the app on it once`)
    }
    db.exec(`CREATE TABLE IF NOT EXISTS dcold.events (
      session_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY (session_id, seq))`)
    db.exec('PRAGMA main.busy_timeout = 60000')
    return run(db, source, { ...opts, dryRun, files, log }, remap)
  } finally {
    source.close()
    db.close()
  }
}

function run(
  db: DatabaseSync,
  source: DatabaseSync,
  opts: Required<Pick<ImportOptions, 'from' | 'into' | 'dryRun' | 'files' | 'log'>> & ImportOptions,
  remap: Remapper
): ImportReport {
  const { from, into, dryRun, files, log } = opts
  const label = opts.label ?? 'mac'
  const counts: TableCount[] = []
  const have = (table: string, schema = 'main'): number => count(db, `SELECT count(*) AS n FROM ${schema}.${table}`)
  const srcRows = (table: string): Row[] => source.prepare(`SELECT * FROM main.${table}`).all() as Row[]
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

  // Compare seq sets across both destination tiers. Counts alone cannot
  // tell a complete session from one with holes and unrelated extra rows.
  const srcSessionIds = new Set(srcSessions.map((s) => String(s.id)))
  const existingSeqs = db.prepare(`SELECT seq FROM main.events WHERE session_id = ?
    UNION SELECT seq FROM dcold.events WHERE session_id = ?`)
  const seqs = (id: string): Set<number> =>
    new Set((existingSeqs.all(id, id) as { seq: number }[]).map((r) => r.seq))
  const hotPending: string[] = []
  const coldPending: string[] = []
  const pending = (schema: 'main' | 'scold', ids: string[]): number => {
    let add = 0
    const rows = source.prepare(
      `SELECT seq FROM ${schema}.events WHERE session_id = ?` +
        (schema === 'scold'
          ? ` AND NOT EXISTS (SELECT 1 FROM main.events h
        WHERE h.session_id = scold.events.session_id AND h.seq = scold.events.seq)`
          : '')
    )
    for (const id of srcSessionIds) {
      const have = seqs(id)
      let missing = 0
      for (const row of rows.iterate(id)) if (!have.has(Number(row.seq))) missing++
      if (missing) {
        add += missing
        ids.push(id)
      }
    }
    return add
  }
  counts.push({ table: 'events', have: have('events'), add: pending('main', hotPending) })
  counts.push({
    table: 'cold.events',
    have: have('events', 'dcold'),
    add: pending('scold', coldPending)
  })

  const dstFoldIds = dstIds('session_folds', 'session_id')
  const foldRows = srcRows('session_folds').filter(
    (f) => srcSessionIds.has(String(f.session_id)) && !dstFoldIds.has(String(f.session_id))
  )
  counts.push({ table: 'session_folds', have: have('session_folds'), add: foldRows.length })

  const copyEvents = (schema: 'main' | 'scold', ids: string[]): void => {
    const rows = source.prepare(
      `SELECT seq, ts, payload FROM ${schema}.events WHERE session_id = ?`
    )
    const stmt = db.prepare(`INSERT OR IGNORE INTO ${schema === 'main' ? 'main' : 'dcold'}.events
      (session_id, seq, ts, payload) VALUES (?, ?, ?, ?)`)
    for (const id of ids) {
      const have = seqs(id)
      for (const row of rows.iterate(id)) {
        if (!have.has(Number(row.seq))) stmt.run(id, row.seq, row.ts, row.payload)
      }
    }
  }

  const noteRows: Row[] = []
  if (tableExists(source, 'main', 'notes') && tableExists(db, 'main', 'notes')) {
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
    copyEvents('main', hotPending)
    insert('session_folds', foldRows)
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
      copyEvents('scold', ids)
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
    if (sessionMapped.get(id))
      rewriteManifest(join(into, 'checkpoints', id, 'manifest.json'), remap)
  }
  for (const id of renderDirs)
    copyDir(join(from, 'html-renders', id), join(into, 'html-renders', id))
  if (files)
    log(
      `files: ${checkpointDirs.length} checkpoint dirs, ${renderDirs.length} html-render dirs copied`
    )

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
