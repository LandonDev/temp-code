import { z } from 'zod'

// Dev servers forwarded to the Mac (docs/box.md "Dev servers on the box").
// A host's live ports (a thread's `port` resource, or a dev run's listener)
// go down every registered Mac's peer link as one list; the Mac binds
// 127.0.0.1:<port> itself (the same number when free, else the next free one
// above it) and reports what it bound. Every connection the Mac accepts is a
// stream on the link, the box dialing its own loopback for it:
//
//   box → Mac  { push: 'ports', from, ports }                 the whole list, on every change and at register
//   Mac → box  ports.bound { from, bound }                    what the Mac bound for each
//   Mac → box  ports.open { from, streamId, forwardId }       a connection came in; answers once the box dialed
//   Mac → box  ports.data { from, streamId, seq, data }       its bytes (base64), the answer is the ack
//   box → Mac  { push: 'ports.data', streamId, seq, data }    the box side's bytes
//   either     ports.close / { push: 'ports.close' }          one side ended, after `seq` data frames
//
// The switch is the Mac's (`ports.forward.<envId>`, on by default): off
// closes every forward of that host.

/** One port a host offers its Macs. */
export interface ForwardedPort {
  /** The resource id of a thread's port, or `dev:<runId>:<port>` for a dev run's. */
  id: string
  /** The number on the host (what the host dials on its own loopback). */
  port: number
  /** The announced URL or the command. */
  label: string
  /** The thread's title, or the dev target's name. */
  title: string
  sessionId: string | null
  runId: string | null
}

/** What a Mac bound for one forwarded port. */
export interface PortBinding {
  id: string
  /** The Mac's number, null when it could not bind one (error says why). */
  macPort: number | null
  error: string | null
}

/** Where a port is forwarded, as the host knows it (a resource row, a dev run). */
export interface PortForwardInfo {
  /** The Mac's environment id. */
  environmentId: string
  /** What this host calls that Mac ("Landon's Mac"). */
  hostName: string | null
  macPort: number | null
  error: string | null
}

/** One forward on the Mac, for its Settings row. */
export interface MacForward {
  id: string
  /** The number on the host. */
  port: number
  macPort: number | null
  label: string
  title: string
  error: string | null
  /** Connections open through it now. */
  connections: number
}

/** A host the Mac forwards from. */
export interface ForwardHost {
  environmentId: string
  name: string
  enabled: boolean
  connected: boolean
  forwards: MacForward[]
}

/** The peer.register offer of a host that takes forwards over its link. */
export const PORTS_OFFER = 'ports'

/** A frame's data is at most this many bytes before base64 (a socket read is split to it). */
export const PORT_CHUNK_BYTES = 64 * 1024
/** Pause the source socket while the link holds more than this unsent... */
export const PORT_HIGH_WATER = 1024 * 1024
/** ...and resume it below this. */
export const PORT_LOW_WATER = 256 * 1024
/** Unanswered ports.data requests a Mac stream may have out before it pauses its socket. */
export const PORT_WINDOW_FRAMES = 32
/** How far above the wanted number the Mac looks for a free one. */
export const PORT_SEARCH_SPAN = 100

const request = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ id: z.string(), method: z.literal(method), params })
const id = z.string().min(1).max(200)

export const PortsRequestSchemas = [
  /** Mac → box: what the Mac bound for the host's list. → { ok } */
  request(
    'ports.bound',
    z.object({
      from: id,
      bound: z.array(z.object({ id, macPort: z.number().int().nullable(), error: z.string().max(500).nullable() })).max(500)
    })
  ),
  /** Mac → box: a connection came in on a forward; the box dials its loopback. → { ok } */
  request('ports.open', z.object({ from: id, streamId: id, forwardId: id })),
  /** Mac → box: the connection's bytes, base64; the answer is the ack. → { ok } */
  request('ports.data', z.object({ from: id, streamId: id, seq: z.number().int().min(0), data: z.string().max(PORT_CHUNK_BYTES * 2) })),
  /** Mac → box: the Mac's side ended. → { ok } */
  request('ports.close', z.object({ from: id, streamId: id, seq: z.number().int().min(0), error: z.string().max(500).optional() })),
  /** The Mac's own renderer: every host it forwards from, with what is bound. → { hosts: ForwardHost[] } */
  request('ports.forwards', z.object({}).optional()),
  /** The Mac's own renderer: a host's switch. → { hosts: ForwardHost[] } */
  request('ports.setForwarding', z.object({ environmentId: id, enabled: z.boolean() }))
] as const

export type PortsPush =
  | { push: 'ports'; from: string; ports: ForwardedPort[] }
  | { push: 'ports.data'; streamId: string; seq: number; data: string }
  /** `seq` is how many data frames went before it: the receiver closes once it delivered them all. */
  | { push: 'ports.close'; streamId: string; seq: number; error?: string }
  /** To the Mac's own renderer sockets when a forward or a switch changes. */
  | { push: 'port-forwards'; hosts: ForwardHost[] }

/** The Mac's URL for a forward. */
export const macUrl = (macPort: number): string => `http://localhost:${macPort}`

/** The line a thread reads in its command's result: "Forwarded to http://localhost:5174 on the Mac (5173 is taken there)". */
export function forwardedLine(port: number, forwards: readonly PortForwardInfo[]): string | null {
  const bound = forwards.filter((f) => f.macPort !== null)
  if (!bound.length) {
    const err = forwards.find((f) => f.error)
    return err ? `Port ${port} was not forwarded to the Mac: ${err.error}` : null
  }
  return bound
    .map((f) => {
      const where = bound.length > 1 && f.hostName ? `on ${f.hostName}` : 'on the Mac'
      const moved = f.macPort !== port ? ` (${port} is taken there)` : ''
      return `Forwarded to ${macUrl(f.macPort as number)} ${where}${moved}`
    })
    .join('\n')
}
