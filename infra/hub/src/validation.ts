import { guardTarget } from './target'
import { activityPhases, activityUnits, events, pushEnvironments, type ActivityRow, type ActivityUpdate, type ApnsDevice, type Heartbeat, type Notice, noticeKinds, type NoticeKind } from './types'
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
function seq(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Invalid('Invalid seq')
  return value
}
export function notice(value: unknown): Notice {
  const v = object(value)
  return {
    event: kinds([v.event])[0],
    hostId: id(v.hostId),
    title: str(v.title, 'title'),
    body: str(v.body, 'body', 4096),
    ts: timestamp(v.ts),
    ...(v.environmentId === undefined ? {} : { environmentId: str(v.environmentId, 'environmentId') }),
    ...(v.threadId === undefined ? {} : { threadId: str(v.threadId, 'threadId') }),
    ...(v.seq === undefined ? {} : { seq: seq(v.seq) }),
    ...(v.url === undefined ? {} : { url: url(v.url) }),
    ...(v.subtitle === undefined ? {} : { subtitle: str(v.subtitle, 'subtitle', 200) }),
    ...(v.kind === undefined ? {} : { kind: noticeKind(v.kind) }),
    ...(v.requestId === undefined ? {} : { requestId: str(v.requestId, 'requestId', 200) }),
    ...(v.hostName === undefined ? {} : { hostName: str(v.hostName, 'hostName', 80) })
  }
}
function noticeKind(value: unknown): NoticeKind {
  if (!noticeKinds.includes(value as never)) throw new Invalid('Invalid kind')
  return value as NoticeKind
}
function count(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Invalid(`Invalid ${name}`)
  return value
}
/** An APNs device token: hex, 32 bytes today; the bundle id names the topic. */
export function device(value: unknown, deviceId: string): ApnsDevice {
  const v = object(value)
  const token = str(v.token, 'token', 400)
  if (!/^[0-9a-fA-F]{64,400}$/.test(token)) throw new Invalid('Invalid token')
  const bundleId = str(v.bundleId, 'bundleId', 160)
  if (!/^[A-Za-z0-9.-]+$/.test(bundleId)) throw new Invalid('Invalid bundleId')
  if (!pushEnvironments.includes(v.environment as never)) throw new Invalid('Invalid environment')
  return { deviceId, token: token.toLowerCase(), bundleId, environment: v.environment as ApnsDevice['environment'] }
}
/** `POST /v1/activity`: the thread's state for its Live Activities. */
export function activity(value: unknown): ActivityUpdate {
  const v = object(value)
  if (v.event !== 'update' && v.event !== 'end') throw new Invalid('Invalid event')
  const state = object(v.state)
  if (!activityPhases.includes(state.phase as never)) throw new Invalid('Invalid phase')
  return {
    hostId: id(v.hostId),
    threadId: id(v.threadId),
    event: v.event,
    state: {
      phase: state.phase as ActivityUpdate['state']['phase'],
      since: timestamp(state.since),
      ts: timestamp(state.ts),
      ...(state.seq === undefined ? {} : { seq: seq(state.seq) }),
      ...(state.title === undefined ? {} : { title: str(state.title, 'title', 200) }),
      ...(state.task === undefined ? {} : { task: str(state.task, 'task', 200) }),
      ...(state.done === undefined ? {} : { done: count(state.done, 'done') }),
      ...(state.total === undefined ? {} : { total: count(state.total, 'total') }),
      ...(state.unit === undefined ? {} : { unit: unit(state.unit) }),
      ...(state.reason === undefined ? {} : { reason: str(state.reason, 'reason', 200) }),
      ...(state.threads === undefined ? {} : { threads: activityRows(state.threads) }),
      ...(state.more === undefined ? {} : { more: count(state.more, 'more') })
    },
    ts: timestamp(v.ts),
    ...(v.environmentId === undefined ? {} : { environmentId: str(v.environmentId, 'environmentId') }),
    ...(v.title === undefined ? {} : { title: str(v.title, 'title') }),
    ...(v.threadType === undefined ? {} : { threadType: str(v.threadType, 'threadType', 40) }),
    ...(v.priority === undefined ? {} : { priority: v.priority === 5 ? 5 : v.priority === 10 ? 10 : invalidPriority() })
  }
}
/** A group's rows: at most 12, each the single state's fields with the thread's id and type. */
function activityRows(value: unknown): ActivityRow[] {
  if (!Array.isArray(value) || value.length > 12) throw new Invalid('Invalid threads')
  return value.map((raw) => {
    const row = object(raw)
    if (!activityPhases.includes(row.phase as never)) throw new Invalid('Invalid phase')
    return {
      id: id(row.id),
      ...(row.type === undefined ? {} : { type: str(row.type, 'type', 40) }),
      phase: row.phase as ActivityRow['phase'],
      since: timestamp(row.since),
      ...(row.ts === undefined ? {} : { ts: timestamp(row.ts) }),
      ...(row.title === undefined ? {} : { title: str(row.title, 'title', 200) }),
      ...(row.task === undefined ? {} : { task: str(row.task, 'task', 200) }),
      ...(row.done === undefined ? {} : { done: count(row.done, 'done') }),
      ...(row.total === undefined ? {} : { total: count(row.total, 'total') }),
      ...(row.unit === undefined ? {} : { unit: unit(row.unit) }),
      ...(row.reason === undefined ? {} : { reason: str(row.reason, 'reason', 200) })
    }
  })
}
function unit(value: unknown): ActivityUpdate['state']['unit'] {
  if (!activityUnits.includes(value as never)) throw new Invalid('Invalid unit')
  return value as ActivityUpdate['state']['unit']
}
function invalidPriority(): never {
  throw new Invalid('Invalid priority')
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
