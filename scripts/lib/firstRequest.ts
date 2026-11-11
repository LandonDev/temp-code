/**
 * The pure half of scripts/measure-first-request.ts: a thread's first model
 * request, read off the gateway's `[gateway:shape]` lines, as a table of its
 * parts scaled to the exact input tokens the answer reported.
 */
import type { RequestShape, ShapeUsage } from '../../src/main/server/gatewayShape'

export interface ShapeRecord extends RequestShape {
  thread: string | null
  status: number | null
  usage: ShapeUsage | null
}

/** Every shape line in a log, in order. */
export function shapeRecords(log: string): ShapeRecord[] {
  const out: ShapeRecord[] = []
  for (const line of log.split('\n')) {
    const at = line.indexOf('[gateway:shape] ')
    if (at < 0) continue
    try {
      out.push(JSON.parse(line.slice(at + '[gateway:shape] '.length)) as ShapeRecord)
    } catch {
      // A line cut by a crash: skipped.
    }
  }
  return out
}

/** A thread's first main request: its model, with tools (a side call such as a title or quota probe carries none).
 *  Codex in code mode sends its tools as an input item, so a Responses request on the thread's model counts without them. */
export function firstRequest(records: ShapeRecord[], thread: string, model: string): ShapeRecord | null {
  const mine = records.filter((r) => r.thread === thread)
  const bare = model.replace(/\[1m\]$/, '')
  const onModel = (r: ShapeRecord): boolean => r.model === null || r.model.startsWith(bare)
  return mine.find((r) => r.tools.count > 0 && onModel(r)) ?? mine.find((r) => r.lane === 'responses' && onModel(r)) ?? mine.find((r) => r.tools.count > 0) ?? null
}

export interface OverheadRow {
  part: string
  bytes: number
  tokens: number
  share: number
}

/** A part's plain name: the file's path, the system prompt summed, the reminders summed. */
function label(name: string): string {
  if (name.startsWith('system')) return 'System prompt'
  if (name.startsWith('file:')) {
    const path = name.slice(5)
    if (/\/memory\/MEMORY\.md$/.test(path)) return 'Auto memory MEMORY.md'
    if (/\/\.claude[^/]*\/CLAUDE\.md$|claude-config\/[^/]+\/CLAUDE\.md$/.test(path)) return 'User CLAUDE.md'
    if (/\/CLAUDE\.md$/.test(path)) return 'Project CLAUDE.md'
    return `File ${path}`
  }
  if (name.startsWith('reminder:')) return 'Other system reminders (skills, deferred tools, context)'
  if (name.startsWith('user:')) return 'The first message'
  if (name.startsWith('messages:')) return 'Other messages'
  if (name === 'instructions') return 'Instructions'
  if (name === 'input:developer:message') return 'Developer messages'
  if (name === 'input:user:message') return 'User messages (AGENTS.md, context, the message)'
  if (name === 'input:developer:additional_tools') return 'Tools in code mode (additional_tools)'
  return name
}

/** The table: tools first, then every part by size, each part's bytes scaled to the reported input tokens. */
export function overheadRows(r: ShapeRecord): OverheadRow[] {
  const sums = new Map<string, number>()
  const add = (k: string, n: number): void => {
    sums.set(k, (sums.get(k) ?? 0) + n)
  }
  add(`Tool definitions (${r.tools.count}, ${r.tools.deferred} deferred)`, r.tools.bytes)
  for (const p of r.parts) add(label(p.name), p.bytes)
  const counted = [...sums.values()].reduce((a, b) => a + b, 0)
  if (r.bytes > counted) add('JSON framing and settings', r.bytes - counted)
  const input = r.usage?.input ?? 0
  return [...sums.entries()]
    .map(([part, bytes]) => ({ part, bytes, share: bytes / r.bytes, tokens: Math.round((bytes / r.bytes) * input) }))
    .sort((a, b) => b.bytes - a.bytes)
}

const k = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`

export interface Measured {
  provider: string
  model: string
  record: ShapeRecord | null
  window: number | null
  note?: string
}

/** How a Responses request carried its tools: code mode (one additional_tools item, Codex with the model's metadata) or inline (every tool a function: the fallback). */
export function toolSurface(r: ShapeRecord): string {
  const code = r.parts.some((p) => p.name.endsWith(':additional_tools'))
  if (code) return 'code mode (additional_tools)'
  return r.tools.count ? `inline, ${r.tools.count} tools` : 'none'
}

/** One thread's markdown: its total against the window, then the parts. */
export function overheadMarkdown(m: Measured): string {
  const head = `### ${m.provider} ${m.model}`
  if (!m.record) return `${head}\n\n${m.note ?? 'No first request was seen.'}\n`
  const input = m.record.usage?.input ?? null
  const window = m.window
  const total = input === null ? 'input tokens not reported' : `${k(input)} input tokens${window ? ` of a ${k(window)} window (${pct(input / window)})` : ''}`
  const lines = [head, '', `First request: ${m.record.bytes.toLocaleString('en-US')} bytes, ${total}.`, '', '| Part | Bytes | ≈ tokens | Share |', '|---|---:|---:|---:|']
  for (const row of overheadRows(m.record)) lines.push(`| ${row.part} | ${row.bytes.toLocaleString('en-US')} | ${k(row.tokens)} | ${pct(row.share)} |`)
  if (m.record.lane === 'responses') lines.push('', `Tool surface: ${toolSurface(m.record)}.`)
  const groups = Object.entries(m.record.tools.groups).sort((a, b) => b[1] - a[1])
  if (groups.length > 1) lines.push('', `Tools by group: ${groups.map(([g, n]) => `${g} ${n.toLocaleString('en-US')}`).join(', ')}.`)
  if (m.note) lines.push('', m.note)
  return `${lines.join('\n')}\n`
}

/** The doc with one run's section put in place: a section of the same heading is replaced, else the section is appended. */
export function placeSection(doc: string, heading: string, body: string): string {
  const section = `## ${heading}\n\n${body.trim()}\n`
  const start = doc.indexOf(`\n## ${heading}\n`)
  if (start < 0) return `${doc.trimEnd()}\n\n${section}`
  const next = doc.indexOf('\n## ', start + 4)
  return `${doc.slice(0, start + 1)}${section}${next < 0 ? '' : doc.slice(next)}`
}
