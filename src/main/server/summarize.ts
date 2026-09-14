import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { harnessEnv, resolveBinary } from './drivers/binaries'
import { oneShotBudget, trackChild } from './spawnBudget'
import type { Store } from './db'
import type { SessionMeta } from '@shared/events'
import type { SessionRegistry } from './sessions'

/**
 * One-sentence summaries for settled tool sections. Cheapest fast model on
 * the subscription the thread already burns — no API key, no new billing:
 *   claude threads → `claude -p` on Haiku 4.5
 *   codex threads  → `codex exec` on GPT-5.3 Codex Spark at low effort
 * Results cache permanently in the settings table (a section's history
 * never changes), so each group is paid for exactly once.
 *
 * Both CLIs would otherwise boot every MCP server the user has configured
 * (a Convex server alone is several hundred megabytes) for a one-line
 * answer that uses no tools. Summaries run with MCP off, no tools, two at
 * a time (`oneShotBudget`): a transcript opening asks for hundreds.
 */

let registry: SessionRegistry | null = null
let store: Store | null = null
export function setSummarizeContext(r: SessionRegistry, s: Store): void {
  registry = r
  store = s
}

export interface SummarizeItem {
  name: string
  detail: string
  output?: string
}

export type SummaryModel = 'auto' | 'haiku' | 'spark'

export interface SummaryResult {
  sentence: string | null
  /** aligned with the request's items; null where the model gave nothing */
  captions: (string | null)[]
}

/** Keep the prompt tiny — the sentence needs the gist, not the transcript. */
const DETAIL_CAP = 140
const OUTPUT_CAP = 220
const TOTAL_CAP = 4000
const TIMEOUT_MS = 60_000

/** Ids never reach the model — threads and plans go by their titles.
 *  Raw rows, not the decorated list: this runs per tool line. */
function humanizeIds(text: string, sessions: SessionMeta[]): string {
  let out = text
  for (const s of sessions) {
    if (!out.includes(s.id)) continue
    out = out
      .replaceAll(`plan-${s.id}.md`, `the plan "${s.title}"`)
      .replaceAll(s.id, `"${s.title}"`)
  }
  return out
}

/** Session rows for humanizeIds, re-read at most every few seconds:
 *  summaries come in bursts of hundreds when a transcript opens. */
let rowsCache: { at: number; rows: SessionMeta[] } | null = null
function sessionRows(): SessionMeta[] {
  const now = Date.now()
  if (!rowsCache || now - rowsCache.at > 5_000) rowsCache = { at: now, rows: store?.listSessions() ?? [] }
  return rowsCache.rows
}

function buildPrompt(items: SummarizeItem[], captions: boolean): string {
  const lines: string[] = []
  let budget = TOTAL_CAP
  const sessions = sessionRows()
  items.forEach((it, n) => {
    const detail = humanizeIds(it.detail.replace(/\s+/g, ' '), sessions).slice(0, DETAIL_CAP)
    const output = it.output
      ? humanizeIds(it.output.replace(/\s+/g, ' '), sessions).slice(0, OUTPUT_CAP)
      : ''
    const line = `${n + 1}. ${it.name}: ${detail}${output ? ` → ${output}` : ''}`
    if (line.length > budget) return
    budget -= line.length
    lines.push(line)
  })
  const ask = captions
    ? `Reply with exactly ${items.length + 1} lines and nothing else:
Line 1: ONE short first-person sentence (under 130 characters) from the agent's point of view, plain talk — like "I looked for the command handlers, then started wiring the new setting."
Then one line per numbered call, in order, formatted "N: <short plain phrase>" — each under 60 characters, past tense, like "Read the service registry" or "Tried to find files related to commands".`
    : `Reply with ONE short first-person sentence (under 130 characters) from the agent's point of view, plain talk — like "I looked through the service code and ran the tests — all passing." Output only the sentence.`
  return `A coding agent just ran these numbered tool calls (name: what it did → trimmed output):

${lines.join('\n')}

${ask}
Speak plainly for a non-expert reader. Refer to threads, plans, and files by their quoted names or titles — never by ids or long paths. No lists beyond the requested lines, no separators, no quotes around your reply, no preamble.`
}

/** Parse the model's reply into sentence + per-item captions. */
function parseReply(raw: string, count: number, captions: boolean): SummaryResult | null {
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length === 0) return null
  const sentence = clean(lines[0])
  const out: (string | null)[] = Array.from({ length: count }, () => null)
  if (captions) {
    for (const l of lines.slice(1)) {
      const m = /^(\d+)\s*[:.)\-–]\s*(.+)$/.exec(l)
      if (!m) continue
      const idx = Number(m[1]) - 1
      if (idx >= 0 && idx < count) out[idx] = clean(m[2].slice(0, 90))
    }
  }
  if (!sentence && out.every((c) => c === null)) return null
  return { sentence, captions: out }
}

/** Run a CLI one-shot with a hard timeout; resolves stdout or null. */
function run(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  readResult: (stdout: string) => string
): Promise<string | null> {
  return oneShotBudget.run(() => runNow(bin, args, env, readResult))
}

function runNow(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  readResult: (stdout: string) => string
): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = trackChild(spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'ignore'] }))
    let out = ''
    let done = false
    const finish = (v: string | null): void => {
      if (!done) {
        done = true
        resolve(v)
      }
    }
    const timer = setTimeout(() => {
      proc.kill()
      finish(null)
    }, TIMEOUT_MS)
    proc.stdout.on('data', (d) => {
      out += String(d)
    })
    proc.on('error', () => {
      clearTimeout(timer)
      finish(null)
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      if (code !== 0) return finish(null)
      try {
        finish(readResult(out))
      } catch {
        finish(null)
      }
    })
  })
}

/** One line of prose, or nothing worth showing. */
function clean(raw: string | null): string | null {
  if (!raw) return null
  const s = raw
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^["'`]+|["'`]+$/g, '')
  if (!s || s.length > 220) return null
  return s
}

async function summarizeWithClaude(prompt: string): Promise<string | null> {
  const bin = await resolveBinary('claude')
  if (!bin) return null
  const env = await harnessEnv()
  return run(bin, ['-p', prompt, '--model', 'claude-haiku-4-5', ...CLAUDE_BARE_ARGS], env, (out) => out)
}

/** No MCP servers, no tools, no skills: the prompt is the whole job. */
export const CLAUDE_BARE_ARGS = [
  '--mcp-config',
  '{"mcpServers":{}}',
  '--strict-mcp-config',
  '--tools',
  '',
  '--disable-slash-commands'
]

/**
 * `codex exec` has no strict-MCP switch, but every configured server can
 * be turned off by name: `-c mcp_servers.<name>.enabled=false`. The names
 * come from the user's config.toml table headers.
 */
export function codexMcpOverrides(configToml: string): string[] {
  const out: string[] = []
  for (const m of configToml.matchAll(/^\s*\[mcp_servers\.([A-Za-z0-9_.-]+)\]\s*$/gm)) {
    const name = m[1]
    if (name.includes('.')) continue // a sub-table (tools, env), not a server
    out.push('-c', `mcp_servers.${name}.enabled=false`)
  }
  return out
}

function codexConfigToml(): string {
  const home = process.env.CODEX_HOME || join(homedir(), '.codex')
  try {
    return readFileSync(join(home, 'config.toml'), 'utf8')
  } catch {
    return ''
  }
}

async function summarizeWithCodex(prompt: string): Promise<string | null> {
  const bin = await resolveBinary('codex')
  if (!bin) return null
  const env = await harnessEnv()
  const dir = mkdtempSync(join(tmpdir(), 'tc-sum-'))
  const outFile = join(dir, 'last.txt')
  try {
    return await run(
      bin,
      [
        'exec',
        '-s',
        'read-only',
        '--skip-git-repo-check',
        '--ephemeral',
        '-m',
        'gpt-5.3-codex-spark',
        '-c',
        'model_reasoning_effort=low',
        ...codexMcpOverrides(codexConfigToml()),
        '-o',
        outFile,
        prompt
      ],
      env,
      () => readFileSync(outFile, 'utf8')
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const inFlight = new Map<string, Promise<SummaryResult | null>>()

/** Stored cache entry; older entries were a bare sentence string. */
function readCache(raw: string | null): SummaryResult | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as { s?: string | null; c?: (string | null)[] }
    return { sentence: v.s ?? null, captions: v.c ?? [] }
  } catch {
    return { sentence: raw, captions: [] }
  }
}

export async function summarizeTools(
  sessionId: string,
  groupKey: string,
  items: SummarizeItem[],
  model: SummaryModel,
  captions: boolean
): Promise<SummaryResult | null> {
  if (!registry || !store || items.length === 0) return null
  const cacheKey = `toolsum:${groupKey}`
  const cached = readCache(store.getSetting(cacheKey))
  // A hit is only complete if it has captions when captions are wanted.
  if (cached && (!captions || cached.captions.some((c) => c !== null))) return cached
  const pending = inFlight.get(cacheKey)
  if (pending) return pending
  const provider = registry.get(sessionId)?.provider
  const useSpark = model === 'spark' || (model === 'auto' && provider === 'codex')
  const prompt = buildPrompt(items, captions)
  const p = (useSpark ? summarizeWithCodex(prompt) : summarizeWithClaude(prompt))
    .then((raw) => {
      const result = raw ? parseReply(raw, items.length, captions) : null
      // Cache successes only — a failed run (logged-out CLI, timeout) may
      // succeed next launch.
      if (result) {
        store?.setSetting(cacheKey, JSON.stringify({ s: result.sentence, c: result.captions }))
      }
      return result
    })
    .finally(() => inFlight.delete(cacheKey))
  inFlight.set(cacheKey, p)
  return p
}
