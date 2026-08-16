import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { harnessEnv, resolveBinary } from './drivers/binaries'
import type { Store } from './db'
import type { SessionRegistry } from './sessions'

/**
 * One-sentence summaries for settled tool sections. Cheapest fast model on
 * the subscription the thread already burns — no API key, no new billing:
 *   claude threads → `claude -p` on Haiku 4.5
 *   codex threads  → `codex exec` on GPT-5.3 Codex Spark at low effort
 * Results cache permanently in the settings table (a section's history
 * never changes), so each group is paid for exactly once.
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

/** Keep the prompt tiny — the sentence needs the gist, not the transcript. */
const DETAIL_CAP = 140
const OUTPUT_CAP = 220
const TOTAL_CAP = 4000
const TIMEOUT_MS = 60_000

function buildPrompt(items: SummarizeItem[]): string {
  const lines: string[] = []
  let budget = TOTAL_CAP
  for (const it of items) {
    const detail = it.detail.replace(/\s+/g, ' ').slice(0, DETAIL_CAP)
    const output = it.output?.replace(/\s+/g, ' ').slice(0, OUTPUT_CAP)
    const line = `- ${it.name}: ${detail}${output ? ` → ${output}` : ''}`
    if (line.length > budget) break
    budget -= line.length
    lines.push(line)
  }
  return `A coding agent just ran these tool calls (name: what it did → trimmed output):

${lines.join('\n')}

Reply with ONE short past-tense sentence (under 130 characters) saying what was done and how it came out. Plain prose — no lists, no separators, no quotes, no preamble. Output only the sentence.`
}

/** Run a CLI one-shot with a hard timeout; resolves stdout or null. */
function run(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  readResult: (stdout: string) => string
): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'ignore'] })
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

/** One sentence, or nothing worth showing. */
function clean(raw: string | null): string | null {
  if (!raw) return null
  const s = raw
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^["'`]+|["'`]+$/g, '')
  if (!s || s.length > 220 || s.includes('\n')) return null
  return s
}

async function summarizeWithClaude(prompt: string): Promise<string | null> {
  const bin = await resolveBinary('claude')
  if (!bin) return null
  const env = await harnessEnv()
  return clean(await run(bin, ['-p', prompt, '--model', 'claude-haiku-4-5'], env, (out) => out))
}

async function summarizeWithCodex(prompt: string): Promise<string | null> {
  const bin = await resolveBinary('codex')
  if (!bin) return null
  const env = await harnessEnv()
  const dir = mkdtempSync(join(tmpdir(), 'tc-sum-'))
  const outFile = join(dir, 'last.txt')
  try {
    return clean(
      await run(
        bin,
        [
          'exec',
          '-s',
          'read-only',
          '--skip-git-repo-check',
          '-m',
          'gpt-5.3-codex-spark',
          '-c',
          'model_reasoning_effort=low',
          '-o',
          outFile,
          prompt
        ],
        env,
        () => readFileSync(outFile, 'utf8')
      )
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const inFlight = new Map<string, Promise<string | null>>()

export async function summarizeTools(
  sessionId: string,
  groupKey: string,
  items: SummarizeItem[]
): Promise<string | null> {
  if (!registry || !store || items.length === 0) return null
  const cacheKey = `toolsum:${groupKey}`
  const cached = store.getSetting(cacheKey)
  if (cached !== null) return cached || null
  const pending = inFlight.get(cacheKey)
  if (pending) return pending
  const provider = registry.list().find((s) => s.id === sessionId)?.provider
  const prompt = buildPrompt(items)
  const p = (provider === 'codex' ? summarizeWithCodex(prompt) : summarizeWithClaude(prompt))
    .then((sentence) => {
      // Cache successes only — a failed run (logged-out CLI, timeout) may
      // succeed next launch.
      if (sentence) store?.setSetting(cacheKey, sentence)
      return sentence
    })
    .finally(() => inFlight.delete(cacheKey))
  inFlight.set(cacheKey, p)
  return p
}
