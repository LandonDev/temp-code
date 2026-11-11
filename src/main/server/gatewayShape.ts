/**
 * What a forwarded request is made of, for TEMP_CODE_GATEWAY_SHAPE=1 (an
 * isolated instance only): one `[gateway:shape]` line per request naming the
 * parts of its body by size, joined with the answer's input usage. The
 * gateway parses no body without the flag; this is a measuring seam
 * (scripts/measure-first-request.ts), never a byte-path feature.
 *
 * Anthropic `/v1/messages`: each system block, the tools (count, deferred,
 * the largest by name), the first user message's blocks (a
 * `<system-reminder>` split on its `Contents of <path>` headings, so each
 * instruction file is its own part) and the rest of the messages. OpenAI
 * Responses: `instructions`, the tools grouped by MCP server or namespace,
 * and the input items by role and type.
 */

import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'
import * as zlib from 'node:zlib'

export type ShapeLane = 'anthropic' | 'responses'

export interface ShapePart {
  name: string
  bytes: number
}

export interface ToolShape {
  count: number
  deferred: number
  bytes: number
  /** The ten largest, by name. */
  largest: ShapePart[]
  /** Bytes per MCP server, namespace or tool type. */
  groups: Record<string, number>
}

export interface RequestShape {
  lane: ShapeLane
  model: string | null
  bytes: number
  parts: ShapePart[]
  tools: ToolShape
}

export interface ShapeUsage {
  input: number
  cacheRead: number
  cacheCreation: number
}

/** Whether this process parses request bodies for the shape line. */
export function shapeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TEMP_CODE_GATEWAY_SHAPE === '1' && !!env.TEMP_CODE_USER_DATA
}

/** The lane a forwarded path speaks, or null for one the shape line does not read. */
export function shapeLaneOf(url: string): ShapeLane | null {
  const path = url.split('?')[0]
  if (/\/v1\/messages$/.test(path)) return 'anthropic'
  if (/\/responses$/.test(path)) return 'responses'
  return null
}

const size = (v: unknown): number => (v === undefined ? 0 : Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v)))

/** The parts of one request body, or null when it is no JSON object. */
export function requestShape(body: Buffer | string, lane: ShapeLane): RequestShape | null {
  let json: unknown
  try {
    json = JSON.parse(typeof body === 'string' ? body : body.toString('utf8'))
  } catch {
    return null
  }
  if (!json || typeof json !== 'object') return null
  const req = json as Record<string, unknown>
  const parts = lane === 'anthropic' ? anthropicParts(req) : responsesParts(req)
  // Every other field by name, so nothing large hides in the framing.
  const read = lane === 'anthropic' ? ['system', 'messages', 'tools', 'model'] : ['instructions', 'input', 'tools', 'model']
  for (const [key, value] of Object.entries(req)) if (!read.includes(key)) parts.push({ name: `field:${key}`, bytes: size(value) })
  return {
    lane,
    model: typeof req.model === 'string' ? req.model : null,
    bytes: Buffer.byteLength(typeof body === 'string' ? body : body.toString('utf8')),
    parts,
    tools: toolShape(Array.isArray(req.tools) ? req.tools : [], lane)
  }
}

function anthropicParts(req: Record<string, unknown>): ShapePart[] {
  const parts: ShapePart[] = []
  const system = req.system
  if (typeof system === 'string') parts.push({ name: 'system', bytes: size(system) })
  else if (Array.isArray(system)) system.forEach((b, i) => parts.push({ name: `system:${i}`, bytes: size(textOf(b) ?? b) }))
  const messages = Array.isArray(req.messages) ? (req.messages as Record<string, unknown>[]) : []
  const first = messages.findIndex((m) => m?.role === 'user')
  if (first >= 0) {
    const content = messages[first].content
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
    blocks.forEach((b, i) => {
      const text = textOf(b)
      if (text !== null && text.includes('<system-reminder>')) parts.push(...reminderParts(text, i))
      else parts.push({ name: `user:${i}:${blockType(b)}`, bytes: size(text ?? b) })
    })
  }
  const rest = messages.filter((_, i) => i !== first)
  if (rest.length) parts.push({ name: `messages:${rest.length}`, bytes: rest.reduce((n, m) => n + size(m), 0) })
  return parts
}

/** A reminder block split on its `Contents of <path>` headings; the text around them is one `reminder` part. */
export function reminderParts(text: string, index: number): ShapePart[] {
  const heading = /^Contents of (\S+?)(?: \([^)]*\))?:\s*$/gm
  const marks: { path: string; at: number }[] = []
  for (let m = heading.exec(text); m; m = heading.exec(text)) marks.push({ path: m[1], at: m.index })
  if (!marks.length) return [{ name: `reminder:${index}`, bytes: size(text) }]
  const parts: ShapePart[] = []
  const lead = text.slice(0, marks[0].at)
  let other = size(lead)
  marks.forEach((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].at : text.length
    let chunk = text.slice(mark.at, end)
    // The last file ends where its reminder does; what follows is the reminder's own.
    const close = i + 1 === marks.length ? chunk.indexOf('</system-reminder>') : -1
    if (close >= 0) {
      other += size(chunk.slice(close))
      chunk = chunk.slice(0, close)
    }
    parts.push({ name: `file:${mark.path}`, bytes: size(chunk) })
  })
  if (other) parts.push({ name: `reminder:${index}`, bytes: other })
  return parts
}

function responsesParts(req: Record<string, unknown>): ShapePart[] {
  const parts: ShapePart[] = []
  if (req.instructions !== undefined) parts.push({ name: 'instructions', bytes: size(req.instructions) })
  const input = typeof req.input === 'string' ? [{ role: 'user', type: 'message', content: req.input }] : Array.isArray(req.input) ? req.input : []
  const byKind = new Map<string, number>()
  for (const item of input as Record<string, unknown>[]) {
    const kind = `input:${[item?.role, item?.type].filter((v) => typeof v === 'string').join(':') || 'item'}`
    byKind.set(kind, (byKind.get(kind) ?? 0) + size(item))
  }
  for (const [name, bytes] of byKind) parts.push({ name, bytes })
  return parts
}

function toolShape(tools: unknown[], lane: ShapeLane): ToolShape {
  const named = tools.map((t) => ({ name: toolName(t), group: toolGroup(t, lane), bytes: size(t), deferred: !!(t as { defer_loading?: unknown })?.defer_loading }))
  const groups: Record<string, number> = {}
  for (const t of named) groups[t.group] = (groups[t.group] ?? 0) + t.bytes
  return {
    count: named.length,
    deferred: named.filter((t) => t.deferred).length,
    bytes: named.reduce((n, t) => n + t.bytes, 0),
    largest: [...named]
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 10)
      .map(({ name, bytes }) => ({ name, bytes })),
    groups
  }
}

function toolName(t: unknown): string {
  const o = (t ?? {}) as Record<string, unknown>
  const fn = o.function as Record<string, unknown> | undefined
  const name = o.name ?? fn?.name ?? o.server_label ?? o.type
  return typeof name === 'string' ? name : '?'
}

/** An MCP tool's server (`mcp__<server>__…`, a Responses `mcp` tool's label), a namespace, else the tool's type. */
function toolGroup(t: unknown, lane: ShapeLane): string {
  const o = (t ?? {}) as Record<string, unknown>
  if (typeof o.namespace === 'string') return o.namespace
  if (o.type === 'mcp' && typeof o.server_label === 'string') return `mcp:${o.server_label}`
  const name = toolName(t)
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(name)
  if (mcp) return `mcp:${mcp[1]}`
  if (lane === 'responses' && name.includes('__')) return name.slice(0, name.indexOf('__'))
  return typeof o.type === 'string' && o.type !== 'function' ? o.type : 'builtin'
}

function textOf(b: unknown): string | null {
  const o = b as { type?: unknown; text?: unknown } | null
  return o && typeof o.text === 'string' ? o.text : null
}

function blockType(b: unknown): string {
  const t = (b as { type?: unknown } | null)?.type
  return typeof t === 'string' ? t : 'block'
}

/** The input usage an answer reports, read off its SSE lines or its JSON body as they stream. */
export class UsageTap {
  usage: ShapeUsage | null = null
  private partial = ''
  private whole = ''
  private stream: boolean | null = null

  feed(chunk: Buffer | string): void {
    if (this.usage) return
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    if (this.stream === null) this.stream = /^\s*(event:|data:|:)/.test(text)
    if (!this.stream) {
      if (this.whole.length < 1 << 22) this.whole += text
      return
    }
    const lines = (this.partial + text).split('\n')
    this.partial = lines.pop() ?? ''
    if (this.partial.length > 1 << 22) this.partial = ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      if (!line.includes('"message_start"') && !line.includes('"response.completed"')) continue
      this.take(line.slice(5))
      if (this.usage) return
    }
  }

  /** The end of the answer: a JSON body is read now. */
  end(): void {
    if (!this.usage && this.stream === false && this.whole) this.take(this.whole)
  }

  private take(text: string): void {
    try {
      const o = JSON.parse(text) as Record<string, unknown>
      const message = o.message as Record<string, unknown> | undefined
      const response = o.response as Record<string, unknown> | undefined
      const u = (message?.usage ?? response?.usage ?? o.usage) as Record<string, unknown> | undefined
      if (u) this.usage = usageOf(u)
    } catch {
      // A line cut short or no JSON: no usage from it.
    }
  }
}

function usageOf(u: Record<string, unknown>): ShapeUsage {
  const n = (v: unknown): number => (typeof v === 'number' ? v : 0)
  const details = u.input_tokens_details as Record<string, unknown> | undefined
  const cached = n(details?.cached_tokens)
  const cacheRead = n(u.cache_read_input_tokens) || cached
  const cacheCreation = n(u.cache_creation_input_tokens)
  // Anthropic counts the cache apart from input_tokens; OpenAI's input_tokens holds the cached ones.
  const input = cached ? n(u.input_tokens) : n(u.input_tokens) + cacheRead + cacheCreation
  return { input, cacheRead, cacheCreation }
}

/** One request's shape and the parser for its answer, or null when the flag is off or the lane is unknown (no parse at all). */
export function startShape(
  enabled: boolean,
  url: string,
  body: Buffer | undefined,
  encoding?: string | string[],
  onUnreadable?: (line: string) => void
): { shape: RequestShape; tap: UsageTap } | null {
  if (!enabled || !body) return null
  const lane = shapeLaneOf(url)
  if (!lane) return null
  const enc = Array.isArray(encoding) ? encoding[0] : encoding
  const plain = decoded(body, enc)
  const shape = plain ? requestShape(plain, lane) : null
  // A body the measure cannot read says so, so a missing row has a reason.
  if (!shape) onUnreadable?.(`[gateway:shape] ${JSON.stringify({ unreadable: true, lane, encoding: enc ?? null, bytes: body.length, head: body.subarray(0, 4).toString('hex') })}`)
  return shape ? { shape, tap: new UsageTap() } : null
}

/** A body as its content-encoding sent it, plain (codex compresses its requests with zstd), or null when it cannot be read. */
export function decoded(body: Buffer, encoding: string | undefined): Buffer | null {
  try {
    switch ((encoding ?? '').trim().toLowerCase()) {
      case '':
      case 'identity':
        return body
      case 'gzip':
        return gunzipSync(body)
      case 'deflate':
        return inflateSync(body)
      case 'br':
        return brotliDecompressSync(body)
      case 'zstd': {
        const zstd = (zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync
        return zstd ? zstd(body) : null
      }
      default:
        return null
    }
  } catch {
    return null
  }
}

/** The `[gateway:shape]` line: one JSON object, so the measure script reads it whole. */
export function shapeLine(thread: string | null, shape: RequestShape, usage: ShapeUsage | null, status: number | null): string {
  return `[gateway:shape] ${JSON.stringify({ thread, status, ...shape, usage })}`
}
