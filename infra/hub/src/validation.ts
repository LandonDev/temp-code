import { guardTarget } from './target'
import { events, type Heartbeat, type Notice } from './types'
export class Invalid extends Error {}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Invalid('Expected an object')
  return value as Record<string, unknown>
}
export function str(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Invalid('Invalid ' + field)
  return value
}
export function id(value: unknown): string {
  const result = str(value, 'id', 128)
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) throw new Invalid('Invalid id')
  return result
}
function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new Invalid('Invalid timestamp (expected Unix milliseconds)')
  return value
}
export function url(value: unknown): string {
  const result = str(value, 'url', 2048)
  let parsed: URL
  try {
    parsed = new URL(result)
  } catch {
    throw new Invalid('Invalid url')
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
    throw new Invalid('Expected HTTPS url without credentials')
  return result
}
/** A subscription's target: `url()` plus the host check of target.ts, resolved now and again at delivery. */
export async function webhookUrl(value: unknown): Promise<string> {
  const result = url(value)
  await guardTarget(new URL(result).hostname)
  return result
}
export function secret(value: unknown): string {
  const result = str(value, 'secret', 512)
  if (result.length < 8) throw new Invalid('Secret needs at least 8 characters')
  return result
}
export function kinds(value: unknown): Notice['event'][] {
  if (!Array.isArray(value) || !value.length || value.some((v) => !events.includes(v)))
    throw new Invalid('Invalid events')
  return [...new Set(value)]
}
export function heartbeat(value: unknown): Heartbeat {
  const v = object(value)
  let load: Heartbeat['load']
  if (v.load !== undefined) {
    const raw = object(v.load)
    if (
      JSON.stringify(raw).length > 1024 ||
      Object.keys(raw).length > 16 ||
      Object.values(raw).some(
        (x) =>
          !['string', 'number', 'boolean'].includes(typeof x) ||
          (typeof x === 'number' && !Number.isFinite(x))
      )
    )
      throw new Invalid('Invalid load')
    load = raw as Heartbeat['load']
  }
  return {
    environmentId: str(v.environmentId, 'environmentId'),
    name: str(v.name, 'name'),
    version: str(v.version, 'version'),
    startedAt: timestamp(v.startedAt),
    ...(load ? { load } : {})
  }
}
export function notice(value: unknown): Notice {
  const v = object(value)
  return {
    event: kinds([v.event])[0],
    hostId: id(v.hostId),
    title: str(v.title, 'title'),
    body: str(v.body, 'body', 4096),
    ts: timestamp(v.ts),
    ...(v.threadId === undefined ? {} : { threadId: str(v.threadId, 'threadId') }),
    ...(v.url === undefined ? {} : { url: url(v.url) })
  }
}
export async function readJson(request: Request): Promise<unknown> {
  // Bound streamed bodies too; Content-Length alone is not trustworthy.
  const reader = request.body?.getReader()
  if (!reader) throw new Invalid('Expected JSON body')
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > 16_384) {
      await reader.cancel()
      throw new Invalid('Body exceeds 16 KiB')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new Invalid('Invalid JSON')
  }
}
