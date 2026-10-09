import { createReadStream, readdirSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { open } from './store'

/**
 * Reads the CLIs' own session logs into the analytics store.
 *
 * Incremental by (mtime, size, byte offset): a file already read to its end is
 * skipped, and one that grew is resumed from where we stopped. That matters —
 * there are thousands of Codex rollout files and a full rescan on every launch
 * would be minutes of work for no new rows.
 */
const CLAUDE_ROOT = join(homedir(), '.claude', 'projects')
const CODEX_ROOT = join(homedir(), '.codex', 'sessions')

export interface IndexProgress {
  running: boolean
  filesDone: number
  filesTotal: number
  rows: number
}

let progress: IndexProgress = { running: false, filesDone: 0, filesTotal: 0, rows: 0 }
export const indexProgress = (): IndexProgress => ({ ...progress })

function* walk(dir: string): Generator<string> {
  let entries: { name: string; isDirectory: () => boolean }[]
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (e.name.endsWith('.jsonl')) yield p
  }
}

const ms = (iso: unknown): number | null => {
  if (typeof iso !== 'string') return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : t
}

/** ~/.claude/projects/-Users-landon-IdeaProjects-Aliax → Aliax */
const projectName = (dirName: string): string => {
  const parts = dirName.split('-').filter(Boolean)
  return parts[parts.length - 1] ?? dirName
}

const toolKind = (name: string): string =>
  name.startsWith('mcp__') ? 'mcp' : name === 'Skill' ? 'skill' : 'builtin'

interface Sink {
  turn: ReturnType<ReturnType<typeof open>['prepare']>
  tool: ReturnType<ReturnType<typeof open>['prepare']>
  event: ReturnType<ReturnType<typeof open>['prepare']>
  usage: ReturnType<ReturnType<typeof open>['prepare']>
}

function parseClaudeLine(line: string, project: string, sink: Sink): number {
  let d: Record<string, unknown>
  try {
    d = JSON.parse(line)
  } catch {
    return 0
  }
  const ts = ms(d.timestamp)
  if (ts === null) return 0
  const message = d.message as Record<string, unknown> | undefined
  let rows = 0

  const usage = message?.usage as Record<string, number> | undefined
  if (d.type === 'assistant' && usage) {
    const creation = (message?.usage as Record<string, Record<string, number>>)?.cache_creation ?? {}
    sink.turn.run(
      'claude-code',
      ts,
      (d.sessionId as string) ?? null,
      project,
      (d.gitBranch as string) || null,
      (message?.model as string) ?? null,
      (d.entrypoint as string) ?? null,
      (d.effort as string) ?? null,
      usage.input_tokens ?? 0,
      usage.output_tokens ?? 0,
      usage.cache_read_input_tokens ?? 0,
      usage.cache_creation_input_tokens ?? 0,
      creation.ephemeral_1h_input_tokens ?? 0,
      creation.ephemeral_5m_input_tokens ?? 0,
      (message?.stop_reason as string) ?? null
    )
    rows++
  }

  const content = message?.content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && block.type === 'tool_use' && block.name) {
        sink.tool.run('claude-code', ts, (d.sessionId as string) ?? null, block.name, toolKind(block.name))
        rows++
      }
    }
  }
  return rows
}

function parseCodexLine(line: string, session: string, sink: Sink): number {
  let d: Record<string, unknown>
  try {
    d = JSON.parse(line)
  } catch {
    return 0
  }
  const ts = ms(d.timestamp)
  if (ts === null) return 0
  const payload = d.payload as Record<string, unknown> | undefined
  const type = payload?.type
  let rows = 0

  if (type === 'token_count') {
    const info = payload?.info as Record<string, Record<string, number>> | undefined
    const last = info?.last_token_usage
    if (last) {
      sink.turn.run(
        'codex',
        ts,
        session,
        null,
        null,
        null,
        null,
        null,
        last.input_tokens ?? 0,
        last.output_tokens ?? 0,
        last.cached_input_tokens ?? 0,
        last.cache_write_input_tokens ?? 0,
        0,
        0,
        null
      )
      rows++
    }
    // The gold seam: Codex records its rate-limit state alongside token counts,
    // which is months of burn history we would otherwise have to wait for.
    const rl = payload?.rate_limits as Record<string, Record<string, number>> | undefined
    for (const key of ['primary', 'secondary']) {
      const w = rl?.[key]
      if (!w || typeof w.used_percent !== 'number') continue
      const minutes = w.window_minutes ?? (w.limit_window_seconds ? w.limit_window_seconds / 60 : 0)
      // Codex reports the weekly window with slightly different arithmetic in
      // different versions, so bucket by magnitude rather than an exact match —
      // otherwise the same window lands under both 'week' and '168h'.
      const label = !minutes ? key : minutes >= 10000 ? 'week' : `${Math.round(minutes / 60)}h`
      sink.usage.run(
        'codex',
        null,
        ts,
        label,
        w.used_percent,
        typeof w.resets_at === 'number' ? w.resets_at * 1000 : null,
        minutes ? minutes * 60_000 : null
      )
      rows++
    }
  }

  if (type === 'function_call' || type === 'custom_tool_call') {
    const name = (payload?.name as string) ?? 'tool'
    sink.tool.run('codex', ts, session, name, toolKind(name))
    rows++
  }
  if (type === 'context_compacted' || d.type === 'compacted') {
    sink.event.run('codex', ts, session, 'compaction')
    rows++
  }
  if (type === 'turn_aborted') {
    sink.event.run('codex', ts, session, 'aborted')
    rows++
  }
  return rows
}

async function readFrom(path: string, offset: number, onLine: (l: string) => void): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path, { start: offset, encoding: 'utf8' })
    const rl = createInterface({ input: stream, crlfDelay: Infinity })
    rl.on('line', onLine)
    rl.on('close', resolve)
    rl.on('error', reject)
    stream.on('error', reject)
  })
}

/** Index everything new. Safe to call repeatedly; only fresh bytes are parsed. */
export async function indexAll(): Promise<IndexProgress> {
  if (progress.running) return indexProgress()
  const db = open()
  const sink: Sink = {
    turn: db.prepare(
      `INSERT INTO turns (service, ts, session, project, branch, model, surface, effort,
        input, output, cache_read, cache_write, eph_1h, eph_5m, stop_reason)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ),
    tool: db.prepare(
      'INSERT INTO tool_calls (service, ts, session, name, kind) VALUES (?,?,?,?,?)'
    ),
    event: db.prepare(
      'INSERT INTO session_events (service, ts, session, kind) VALUES (?,?,?,?)'
    ),
    usage: db.prepare(
      `INSERT INTO usage_samples (service, account, ts, label, used_percent, resets_at, period_ms)
       VALUES (?,?,?,?,?,?,?)`
    )
  }
  const seen = db.prepare('SELECT mtime, size, offset FROM files WHERE path = ?')
  const mark = db.prepare(
    'INSERT INTO files (path, mtime, size, offset) VALUES (?,?,?,?) ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime, size=excluded.size, offset=excluded.offset'
  )

  const files = [
    ...[...walk(CLAUDE_ROOT)].map((p) => ({ path: p, service: 'claude-code' as const })),
    ...[...walk(CODEX_ROOT)].map((p) => ({ path: p, service: 'codex' as const }))
  ]
  progress = { running: true, filesDone: 0, filesTotal: files.length, rows: 0 }

  for (const { path, service } of files) {
    progress.filesDone++
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(path)
    } catch {
      continue
    }
    const prior = seen.get(path) as { mtime: number; size: number; offset: number } | undefined
    // Unchanged since we last finished it.
    if (prior && prior.mtime === Math.floor(st.mtimeMs) && prior.size === st.size) continue
    // Truncated or rewritten: start over for this file rather than read garbage.
    const start = prior && st.size > prior.size && prior.mtime <= st.mtimeMs ? prior.offset : 0

    const project = service === 'claude-code' ? projectName(basename(join(path, '..'))) : ''
    const session = basename(path).replace(/\.jsonl$/, '')
    let rows = 0
    db.exec('BEGIN')
    try {
      await readFrom(path, start, (line) => {
        if (!line) return
        rows +=
          service === 'claude-code'
            ? parseClaudeLine(line, project, sink)
            : parseCodexLine(line, session, sink)
      })
      mark.run(path, Math.floor(st.mtimeMs), st.size, st.size)
      db.exec('COMMIT')
      progress.rows += rows
    } catch {
      db.exec('ROLLBACK')
    }
    // Let the UI breathe between files on the first, heavy pass.
    if (progress.filesDone % 200 === 0) await new Promise((r) => setImmediate(r))
  }

  progress.running = false
  return indexProgress()
}
