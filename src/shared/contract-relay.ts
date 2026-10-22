import { z } from 'zod'
import type { ClientRequest } from './contract'
import type { BuildFacts } from './deployDrift'

/**
 * The relay (docs/box.md "The relay: the phone and the API reach the Mac
 * through the box"). A client paired with the box opens a second socket
 * lane, `/ws?ticket=…&host=<envId>`, and the box serves it under the Mac's
 * environment id: every request frame crosses the Mac's admin peer link as
 * a `relay.frame` peer call, the Mac's own `attach()` answers it on a
 * virtual socket, and the Mac's frames come back verbatim as `relay.frames`.
 * The box keeps every relayed host's presence (link, screen, power) and
 * refuses a call a state forbids with one typed line. `/mcp` takes a
 * relayed host as one more host (`relay.facade`).
 */

/** The offer a Mac makes in `peer.register` when it will serve relayed lanes and facade calls. */
export const RELAY_OFFER = 'relay'
/** `/ws?ticket=…&host=<envId>`: the query that makes a socket a relayed lane. */
export const RELAY_HOST_QUERY = 'host'
/** Close codes the box uses on a relayed lane. */
export const RELAY_CLOSE_UNREACHABLE = 4010 // the link to the host dropped (or the host went to sleep)
export const RELAY_CLOSE_HOST_CLOSED = 4011 // the host closed its end (backpressure, shutdown)
export const RELAY_CLOSE_CONTRACT = 4012 // the host speaks another contract version
/** One relay.open / relay.frame / relay.close peer call gets this long. */
export const RELAY_CALL_MS = 30_000
/** One relay.facade peer call gets this long (a facade read is bounded; a start may spawn a harness). */
export const RELAY_FACADE_MS = 60_000
/** Bytes of frames one relay.frames request carries at most (a single larger frame goes alone). */
export const RELAY_FRAMES_MAX_BYTES = 2 * 1024 * 1024
/** Queued bytes on a virtual socket past which the host closes it. */
export const RELAY_SOCKET_BUFFER_MAX = 16 * 1024 * 1024
/** The Mac sends its presence this often while a link is up, change or not. */
export const RELAY_HEARTBEAT_MS = 60_000
/** The box keeps the last picture of this many hosts. */
export const RELAY_HOSTS_MAX = 16

export const ScreenStateSchema = z.enum(['unlocked', 'locked', 'unknown'])
export const PowerStateSchema = z.enum(['awake', 'asleep', 'unknown'])
export type ScreenState = z.infer<typeof ScreenStateSchema>
export type PowerState = z.infer<typeof PowerStateSchema>

/** What a host reports of itself (src/main/presence.ts). */
export const MacPresenceSchema = z.object({
  screen: ScreenStateSchema,
  power: PowerStateSchema,
  /** When this picture was taken on the host (its clock). */
  at: z.number().int()
})
export type MacPresence = z.infer<typeof MacPresenceSchema>

/** One host reachable through the relay, as the box sees it (wireSchemas.ts HostPresenceSchema pins it). */
export interface HostPresence {
  environmentId: string
  /** The host's hostname as it said in peer.register; "Mac" for an older host that said nothing. */
  name: string
  /** `darwin`, `linux`, …; from the host's build, else `unknown`. */
  platform: string
  link: 'up' | 'down'
  /** When `link` last changed (the box's clock). */
  since: number
  screen: ScreenState
  power: PowerState
  /** The last frame the box took from the host's link (register, presence, reply), null before any. */
  lastSeenAt: number | null
  build: BuildFacts | null
}

/** The one word a client acts on. */
export type RelayState = 'available' | 'locked' | 'asleep' | 'unreachable'

export function relayState(p: Pick<HostPresence, 'link' | 'screen' | 'power'>): RelayState {
  if (p.link === 'down') return 'unreachable'
  if (p.power === 'asleep') return 'asleep'
  if (p.screen === 'locked') return 'locked'
  return 'available'
}

const two = (n: number): string => String(n).padStart(2, '0')
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The local date parts of a moment, in `timeZone` when given (tests), else the process zone. */
function parts(at: number, timeZone?: string): { day: number; month: number; year: number; hour: number; minute: number } {
  if (!timeZone) {
    const d = new Date(at)
    return { day: d.getDate(), month: d.getMonth(), year: d.getFullYear(), hour: d.getHours(), minute: d.getMinutes() }
  }
  const got: Record<string, number> = {}
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(at)))
    if (p.type !== 'literal') got[p.type] = Number(p.value)
  return { day: got.day, month: got.month - 1, year: got.year, hour: got.hour % 24, minute: got.minute }
}

/** `HH:MM` in local time; `D Mon HH:MM` when not today. Pure: takes `now`; `timeZone` fixes the zone (tests). */
export function sinceText(since: number, now: number, timeZone?: string): string {
  const s = parts(since, timeZone)
  const n = parts(now, timeZone)
  const clock = `${two(s.hour)}:${two(s.minute)}`
  const today = s.day === n.day && s.month === n.month && s.year === n.year
  return today ? clock : `${s.day} ${MONTHS[s.month]} ${clock}`
}

/**
 * The refusal for a call to a host in this state, or null when it may run.
 * `need` is the method's row in RELAY_METHODS: a `screen` method is refused on a
 * locked host, everything is refused on an asleep or unreachable one.
 *   unavailable: the Mac is locked
 *   unavailable: the Mac is asleep
 *   unavailable: the Mac is unreachable since 09:14
 */
export function relayRefusal(p: HostPresence, need: 'link' | 'screen', now: number, timeZone?: string): string | null {
  const state = relayState(p)
  if (state === 'unreachable') return `unavailable: the Mac is unreachable since ${sinceText(p.since, now, timeZone)}`
  if (state === 'asleep') return 'unavailable: the Mac is asleep'
  if (state === 'locked' && need === 'screen') return 'unavailable: the Mac is locked'
  return null
}

/** The same words for a request the link drop cut: `linkDown: the Mac is unreachable since 09:14`. */
export function linkDownText(p: Pick<HostPresence, 'since'>, now: number, timeZone?: string): string {
  return `linkDown: the Mac is unreachable since ${sinceText(p.since, now, timeZone)}`
}

/** Which contract methods a relayed lane forwards, and what each needs on the host. */
export const RELAY_METHODS: Partial<Record<ClientRequest['method'], 'link' | 'screen'>> = {
  // the shell
  'catalog.get': 'link',
  'workspace.list': 'link',
  'workspace.icon': 'link',
  'workspace.root': 'link',
  'project.list': 'link',
  'project.changes': 'link',
  'project.diff': 'link',
  'project.files': 'link',
  'project.log': 'link',
  'project.branches': 'link',
  'project.show': 'link',
  'project.compare': 'link',
  'project.blame': 'link',
  'file.read': 'link',
  'fs.media': 'link',
  'fs.readPreview': 'link',
  'fs.read': 'link',
  'fs.list': 'link',
  'fs.projectFiles': 'link',
  'search.project': 'link',
  'session.search': 'link',
  'notes.get': 'link',
  'notes.list': 'link',
  'notes.search': 'link',
  'rules.get': 'link',
  'plans.get': 'link',
  'defaults.get': 'link',
  'review.get': 'link',
  // threads
  'session.list': 'link',
  'session.changes': 'link',
  'session.events': 'link',
  'session.rowBody': 'link',
  'session.subscribe': 'link',
  'session.unsubscribe': 'link',
  'session.context': 'link',
  'session.create': 'link',
  'session.send': 'link',
  'session.interrupt': 'link',
  'session.approve': 'link',
  'session.answer': 'link',
  'session.permission': 'link',
  'session.rename': 'link',
  'session.archive': 'link',
  'session.pin': 'link',
  'session.pause': 'link',
  'session.resume': 'link',
  'session.start': 'link',
  'session.continue': 'link',
  'session.notes.get': 'link',
  'session.notes.set': 'link',
  'queue.list': 'link',
  'queue.add': 'link',
  'queue.remove': 'link',
  'queue.update': 'link',
  'queue.reorder': 'link',
  'queue.steer': 'link',
  'plan.implement': 'link',
  'projectPlan.get': 'link',
  'projectPlan.linkOf': 'link',
  'batch.get': 'link',
  'batch.children': 'link',
  'resources.list': 'link',
  'resources.listAll': 'link',
  'checkpoint.status': 'link',
  // attachments land in the Mac thread's own dir; the Mac fences the paths
  'attachment.begin': 'link',
  'attachment.chunk': 'link',
  'attachment.commit': 'link',
  'attachment.abort': 'link',
  'attachment.settings': 'link',
  'attachment.digest': 'link',
  'attachment.readRange': 'link',
  'attachment.read': 'link',
  // GitHub, read from the Mac's checkout
  'github.inbox': 'link',
  'github.inboxRefresh': 'link',
  'github.details': 'link',
  'github.thread': 'link',
  'github.prDiff': 'link',
  'github.prStatus': 'link',
  // devices: the Mac answers for itself on a relayed lane
  'host.devices.hosts': 'link',
  'host.devices': 'link',
  'host.devices.watch': 'link',
  'host.devices.unwatch': 'link',
  'host.simulator.shutdown': 'link',
  'host.simulator.delete': 'link',
  'host.device.openXcode': 'screen'
}

/** Methods a relayed lane answers on the box itself (the key's own rows). */
export const RELAY_BOX_LOCAL: readonly ClientRequest['method'][] = [
  'remote.push.register',
  'remote.push.unregister',
  'remote.push.status',
  'remote.push.activity'
]

/** The refusal for a method in neither table. */
export const relayForbidden = (method: string): string => `forbidden: ${method} does not relay to another host`

// ── peer.call methods (box → host), inside the admin peer.call push ──────
export const RELAY_PEER_METHODS = ['relay.open', 'relay.frame', 'relay.close', 'relay.facade'] as const
export type RelayPeerMethod = (typeof RELAY_PEER_METHODS)[number]
export const isRelayPeerMethod = (m: string): m is RelayPeerMethod => (RELAY_PEER_METHODS as readonly string[]).includes(m)

/** The relayed caller as the host sees it: the box key's row, never the secret. */
export const RelayPrincipalSchema = z.object({
  keyId: z.string().min(1).max(40),
  name: z.string().max(120),
  audience: z.enum(['client', 'mcp']),
  caps: z.array(z.enum(['read', 'operate', 'approve', 'admin']))
})
export type RelayPrincipal = z.infer<typeof RelayPrincipalSchema>

const socketId = z.string().min(1).max(40)
export const RelayOpenArgsSchema = z.object({ socketId, principal: RelayPrincipalSchema })
/** The frame is the client's request as the box parsed it (ClientRequestSchema); the host parses it again. */
export const RelayFrameArgsSchema = z.object({ socketId, frame: z.unknown() })
export const RelayCloseArgsSchema = z.object({ socketId, reason: z.string().max(200) })
export const RelayFacadeArgsSchema = z.object({
  principal: RelayPrincipalSchema,
  name: z.string().min(1).max(80),
  arguments: z.unknown()
})
export type RelayOpenArgs = z.infer<typeof RelayOpenArgsSchema>
export type RelayFrameArgs = z.infer<typeof RelayFrameArgsSchema>
export type RelayCloseArgs = z.infer<typeof RelayCloseArgsSchema>
export type RelayFacadeArgs = z.infer<typeof RelayFacadeArgsSchema>
export interface RelayCallParams {
  /** The box's environment id. */
  from: string
  args: RelayOpenArgs | RelayFrameArgs | RelayCloseArgs | RelayFacadeArgs
}
export interface RelayOpenResult {
  ok: true
  contract: number
}
export type RelayFacadeResult =
  | { ok: true; result: unknown }
  | { ok: false; code: 'not_found' | 'forbidden' | 'invalid' | 'conflict' | 'unavailable'; message: string }

// ── requests the host sends the box on its own link (admin) ─────────────
const request = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ id: z.string(), method: z.literal(method), params })
const from = z.string().min(1).max(200)
/** A notice of a thread on the host (remote/notifier.ts Notice, without `url`: the box's /ui cannot open it). */
export const RelayNoticeSchema = z.object({
  event: z.enum(['needs_you', 'finished', 'failed', 'stuck']),
  /** The phone's category and actions (notifier.ts NoticeKind); an older host leaves it out and the box reads it off `event`. */
  kind: z.enum(['approval', 'question', 'plan', 'waiting', 'finished', 'failed', 'stuck', 'batch', 'stopped']).optional(),
  threadId: z.string().min(1).max(200),
  title: z.string().max(300),
  /** The project or workspace the thread is in. */
  subtitle: z.string().max(300).optional(),
  body: z.string().max(1_000),
  ts: z.number().int(),
  seq: z.number().int(),
  /** The approval a phone may decide from the notification (kind `approval`), on the host the notice names. */
  requestId: z.string().max(200).optional(),
  /** The host's own name: the phone adds it to the subtitle when several hosts are paired. */
  hostName: z.string().max(120).optional()
})
export type RelayNotice = z.infer<typeof RelayNoticeSchema>
export const RelayRequestSchemas = [
  /** The host's presence changed, or its heartbeat. → { ok: true } */
  request('peer.presence', z.object({ from, presence: MacPresenceSchema })),
  /** Frames the host's attach() sent on a relayed lane, in order. → { ok: true }, or an error naming an unknown socket. */
  request('relay.frames', z.object({ from, socketId, frames: z.array(z.unknown()).min(1).max(500) })),
  /** The host closed its end of a lane. → { ok: true } */
  request('relay.closed', z.object({ from, socketId, reason: z.string().max(200) })),
  /** A notice of a thread on the host, for the box's APNs, hub and webhooks. → { ok: true } */
  request('relay.notice', z.object({ from, notice: RelayNoticeSchema })),
  /** A proof seam (TEMP_CODE_E2E_PRESENCE=1 on an isolated instance): this host's presence, flipped by hand. → MacPresence */
  request('presence.set', z.object({ screen: ScreenStateSchema.optional(), power: PowerStateSchema.optional() }))
] as const
