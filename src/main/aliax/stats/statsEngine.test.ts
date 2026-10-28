import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { StatsEngine } from './statsEngine'
import type { IndexProgress } from './indexer'

/**
 * The stats engine in-process over a temp database and two JSONL fixtures
 * (one Claude Code project log, one Codex rollout): what the index reads,
 * what a second pass skips, what a grown or a truncated file costs, and the
 * bundle cached until a write.
 */
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const hourAgo = () => new Date(Date.now() - 3_600_000).toISOString()
const claudeTurn = (tools: string[] = ['Read', 'mcp__app__update_notes']): string =>
  JSON.stringify({
    type: 'assistant',
    timestamp: hourAgo(),
    sessionId: 's1',
    gitBranch: 'master',
    entrypoint: 'cli',
    effort: 'high',
    message: {
      model: 'claude-haiku-5-5',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1, cache_creation: { ephemeral_5m_input_tokens: 1 } },
      stop_reason: 'end_turn',
      content: tools.map((name) => ({ type: 'tool_use', name }))
    }
  })
const codexTokens = JSON.stringify({
  timestamp: hourAgo(),
  payload: {
    type: 'token_count',
    info: { last_token_usage: { input_tokens: 7, output_tokens: 3, cached_input_tokens: 1, cache_write_input_tokens: 0 } },
    rate_limits: { primary: { used_percent: 42, window_minutes: 300, resets_at: 1793200000 }, secondary: { used_percent: 12, window_minutes: 10080 } }
  }
})
const codexTool = JSON.stringify({ timestamp: hourAgo(), payload: { type: 'function_call', name: 'shell' } })

function rig() {
  const base = mkdtempSync(join(tmpdir(), 'tc-stats-'))
  roots.push(base)
  const claude = join(base, 'claude', '-srv-agents-work-proj')
  const codex = join(base, 'codex', '2026', '10')
  mkdirSync(claude, { recursive: true })
  mkdirSync(codex, { recursive: true })
  const claudeFile = join(claude, 's1.jsonl')
  const codexFile = join(codex, 'rollout-1.jsonl')
  writeFileSync(claudeFile, `${claudeTurn()}\n`)
  writeFileSync(codexFile, `${codexTokens}\n${codexTool}\n`)
  const progress: IndexProgress[] = []
  const engine = new StatsEngine({ dbPath: join(base, 'stats.db'), roots: { claude: join(base, 'claude'), codex: join(base, 'codex') }, onProgress: (p) => progress.push(p) })
  const count = (table: string): number => (engine.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  const offset = (path: string): number | undefined => (engine.db.prepare('SELECT offset FROM files WHERE path = ?').get(path) as { offset: number } | undefined)?.offset
  return { base, engine, claudeFile, codexFile, progress, count, offset }
}

describe('StatsEngine', () => {
  it('reads both logs into the store and the bundle counts them; the progress is mirrored', async () => {
    const r = rig()
    const p = await r.engine.index()
    expect(p).toEqual({ running: false, filesDone: 2, filesTotal: 2, rows: 7 })
    expect(r.count('turns')).toBe(2)
    expect(r.count('tool_calls')).toBe(3)
    expect(r.count('usage_samples')).toBe(2)
    expect(r.engine.db.prepare("SELECT label FROM usage_samples ORDER BY label").all()).toEqual([{ label: '5h' }, { label: 'week' }])
    expect(r.progress[0]).toEqual({ running: true, filesDone: 0, filesTotal: 2, rows: 0 })
    expect(r.progress.at(-1)).toEqual(p)
    expect(r.engine.progress()).toEqual(p)
    const b = r.engine.bundle()
    expect(b.totals.turns).toBe(2)
    expect(b.byTool.map((t) => t.name).sort()).toEqual(['Read', 'mcp__app__update_notes', 'shell'])
    expect(b.byModel.map((m) => m.name)).toContain('claude-haiku-5-5')
    expect(b.unavailable).toBeUndefined()
    r.engine.close()
  })

  it('a second pass reads nothing for unchanged files, and only the appended bytes of one that grew', async () => {
    const r = rig()
    await r.engine.index()
    const read = r.offset(r.claudeFile)!
    expect((await r.engine.index()).rows).toBe(0)
    expect(r.count('turns')).toBe(2)
    appendFileSync(r.claudeFile, `${claudeTurn([])}\n`)
    const grown = await r.engine.index()
    expect(grown.rows).toBe(1)
    expect(r.count('turns')).toBe(3)
    expect(r.offset(r.claudeFile)).toBeGreaterThan(read)
    r.engine.close()
  })

  it('a truncated file is read again from the start', async () => {
    const r = rig()
    await r.engine.index()
    writeFileSync(r.claudeFile, `${claudeTurn([])}\n`)
    const again = await r.engine.index()
    expect(again.rows).toBe(1)
    expect(r.offset(r.claudeFile)).toBe(claudeTurn([]).length + 1)
    r.engine.close()
  })

  it('the bundle is cached until a write: an index pass, a sample (not a duplicate of the minute), an app event', async () => {
    const r = rig()
    await r.engine.index()
    const b1 = r.engine.bundle()
    expect(r.engine.bundle()).toBe(b1)
    r.engine.sample('codex', 'acct', '5h', 50)
    const b2 = r.engine.bundle()
    expect(b2).not.toBe(b1)
    expect(r.count('usage_samples')).toBe(3)
    r.engine.sample('codex', 'acct', '5h', 51)
    expect(r.engine.bundle()).toBe(b2)
    expect(r.count('usage_samples')).toBe(3)
    r.engine.appEvent('switch', 'codex', 'acct')
    const b3 = r.engine.bundle()
    expect(b3).not.toBe(b2)
    expect(r.count('app_events')).toBe(1)
    await r.engine.index()
    expect(r.engine.bundle()).not.toBe(b3)
    r.engine.close()
  })
})
