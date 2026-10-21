import { z } from 'zod'

// Devices on a Mac (docs/box.md "Devices on the Mac"). The Mac's main
// process gathers, only while someone is looking, what the machine is
// running for its threads: the simulators (`xcrun simctl list -j devices`),
// the iPhones connected or paired (`xcrun devicectl list devices`), the
// Xcode those commands use (DEVELOPER_DIR, else the newest Xcode*.app, as
// scripts/ios-device.sh resolves it) and the one-minute load against the
// core count. Each simulator a thread created names that thread (the
// `thread_resources` table, by UDID) so the row says who holds it.
//
// Reaching it:
//  - On the Mac, the renderer asks its own server: `host.devices.hosts`
//    answers this Mac, `host.devices.watch` opens a viewer and a
//    `host.devices` push lands every HOST_DEVICES_INTERVAL_MS while one is
//    open, `host.devices.unwatch` (or the socket closing) releases it.
//    Nothing runs with no viewer.
//  - On a host the Mac is linked to (the box: its /ui web mode, the phone),
//    `host.devices.hosts` lists the Macs registered with the `devices`
//    offer; a watch of one of them polls that Mac over the peer link with
//    a `host.devices` peer.call on the same cadence, so the Mac still runs
//    nothing when no one is looking.
//  - The actions (`host.simulator.shutdown`, `host.simulator.delete`,
//    `host.device.openXcode`) run on the Mac, locally or as the same-named
//    peer.call the Mac performs itself; capability operate either way.

export const HOST_DEVICES_OFFER = 'devices'
/** A viewer's refresh cadence, on the Mac and over the peer link. */
export const HOST_DEVICES_INTERVAL_MS = 30_000
/** A report younger than this answers a second asker without running the tools again. */
export const HOST_DEVICES_FRESH_MS = 5_000
/** How long one gathering pass may take (simctl's first call after a reboot is slow). */
export const HOST_DEVICES_GATHER_MS = 60_000
/** A peer.call for a report or an action gets this long. */
export const HOST_DEVICES_CALL_MS = 90_000

export const HOST_DEVICES_PEER_METHODS = [
  'host.devices',
  'host.simulator.shutdown',
  'host.simulator.delete',
  'host.device.openXcode'
] as const
export type HostDevicesPeerMethod = (typeof HOST_DEVICES_PEER_METHODS)[number]
export const isHostDevicesPeerMethod = (m: string): m is HostDevicesPeerMethod =>
  (HOST_DEVICES_PEER_METHODS as readonly string[]).includes(m)

// ── the report ────────────────────────────────────────────────────────

export const SimulatorStateSchema = z.enum(['booted', 'shutdown', 'other'])
export type SimulatorState = z.infer<typeof SimulatorStateSchema>

/** The thread that holds a device (a `thread_resources` row by UDID). */
export const DeviceHolderSchema = z.object({
  sessionId: z.string(),
  /** The host the thread runs on, when the row says; absent means the answering host. */
  environmentId: z.string().optional(),
  /** The thread's title when the answering host knows the thread, else the row's label. */
  title: z.string(),
  /** The thread's status when known (running, idle, …). */
  status: z.string().optional()
})
export type DeviceHolder = z.infer<typeof DeviceHolderSchema>

export const SimulatorSchema = z.object({
  udid: z.string(),
  name: z.string(),
  /** "iOS 26.0", as simctl's runtime identifier reads. */
  runtime: z.string(),
  state: SimulatorStateSchema,
  /** simctl's own word when state is `other` (Booting, Shutting Down, Creating). */
  stateText: z.string().optional(),
  /** CPU share of the simulator's processes (0–100 per core, summed), for a booted one when ps answered. */
  cpu: z.number().optional(),
  holder: DeviceHolderSchema.nullable()
})
export type Simulator = z.infer<typeof SimulatorSchema>

export const PhoneConnectionSchema = z.enum(['connected', 'paired', 'unavailable'])
export type PhoneConnection = z.infer<typeof PhoneConnectionSchema>

export const PhoneSchema = z.object({
  udid: z.string(),
  name: z.string(),
  /** "iPhone 16 Pro". */
  model: z.string(),
  /** "iOS 26.0". */
  os: z.string(),
  connection: PhoneConnectionSchema,
  /** How it is attached, when connected (USB, Wi-Fi). */
  transport: z.string().optional(),
  holder: DeviceHolderSchema.nullable()
})
export type Phone = z.infer<typeof PhoneSchema>

export const XcodeInfoSchema = z.object({
  /** "/Applications/Xcode-beta.app". */
  path: z.string(),
  /** "Xcode-beta". */
  name: z.string(),
  /** "27.0" when the bundle's version.plist says. */
  version: z.string().optional(),
  /** How it was chosen: the DEVELOPER_DIR in the environment, the newest Xcode*.app, or xcode-select. */
  from: z.enum(['developerDir', 'newest', 'xcodeSelect'])
})
export type XcodeInfo = z.infer<typeof XcodeInfoSchema>

export const HostLoadSchema = z.object({
  /** The one-minute load average. */
  oneMinute: z.number(),
  cores: z.number().int()
})
export type HostLoad = z.infer<typeof HostLoadSchema>

export const HostDevicesReportSchema = z.object({
  /** The environment id of the Mac this describes. */
  environmentId: z.string(),
  /** When the tools ran (epoch ms). */
  at: z.number(),
  simulators: z.array(SimulatorSchema),
  phones: z.array(PhoneSchema),
  xcode: XcodeInfoSchema.nullable(),
  load: HostLoadSchema,
  /** What did not answer: one line per tool that failed, for the pane's note; empty when all ran. */
  problems: z.array(z.string())
})
export type HostDevicesReport = z.infer<typeof HostDevicesReportSchema>

/** One Mac a viewer may watch. */
export interface HostDevicesHost {
  environmentId: string
  name: string
  /** This machine, answered by its own server. */
  local: boolean
}

export type HostDevicesPush = { push: 'host.devices'; report: HostDevicesReport }

/** `peer.call` params for a host.* method: the args (a UDID for the simulator actions). */
export interface HostDevicesCallParams {
  args: { udid?: string }
}

// ── requests ──────────────────────────────────────────────────────────

const request = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ id: z.string(), method: z.literal(method), params })

const envId = z.string().min(1).max(200)
const udid = z.string().min(1).max(100)
/** The Mac asked; absent means the answering machine when it is a Mac. */
const target = z.object({ environmentId: envId.optional() })
const deviceTarget = z.object({ environmentId: envId.optional(), udid })

export const HostDevicesRequestSchemas = [
  /** → HostDevicesHost[]: this Mac, or the Macs registered with the devices offer. */
  request('host.devices.hosts', z.object({}).optional()),
  /** → HostDevicesReport, gathered now (or the fresh one). */
  request('host.devices', target.optional()),
  /** → HostDevicesReport. Opens a viewer on this socket: a `host.devices` push every HOST_DEVICES_INTERVAL_MS until unwatch or the socket closes. */
  request('host.devices.watch', target.optional()),
  /** → { ok: true }. */
  request('host.devices.unwatch', target.optional()),
  /** → HostDevicesReport after the shutdown. */
  request('host.simulator.shutdown', deviceTarget),
  /** → HostDevicesReport after the delete. The renderer confirms first (deleteSimulatorConfirm). */
  request('host.simulator.delete', deviceTarget),
  /** → { ok: true }. Opens Xcode's Devices and Simulators window on the Mac. */
  request('host.device.openXcode', target.optional())
] as const

// ── words the panes share ─────────────────────────────────────────────

/** "iOS: Home, running" — how a holder is named in a line. */
export function holderText(holder: DeviceHolder): string {
  return holder.status ? `${holder.title}, ${holder.status}` : holder.title
}

/** The body of the confirm before a simulator is deleted. */
export function deleteSimulatorConfirm(sim: Pick<Simulator, 'name' | 'runtime' | 'holder'>): {
  title: string
  body: string
} {
  const title = `Delete ${sim.name}?`
  if (sim.holder) return { title, body: `Held by ${holderText(sim.holder)}. Delete anyway?` }
  return { title, body: `${sim.name} (${sim.runtime}) and its data are removed from this Mac.` }
}

/** "3 simulators, 1 booted · iPhone 16 Pro connected · load 2.1 / 10 cores". */
export function devicesSummary(report: Pick<HostDevicesReport, 'simulators' | 'phones' | 'load'>): string {
  const parts: string[] = []
  const sims = report.simulators.length
  const booted = report.simulators.filter((s) => s.state === 'booted').length
  parts.push(
    sims === 0
      ? 'No simulators'
      : `${sims} ${sims === 1 ? 'simulator' : 'simulators'}${booted ? `, ${booted} booted` : ''}`
  )
  const connected = report.phones.filter((p) => p.connection === 'connected')
  const paired = report.phones.filter((p) => p.connection !== 'connected')
  if (connected.length) parts.push(`${connected.map((p) => p.model).join(', ')} connected`)
  else if (paired.length) parts.push(`${paired.length === 1 ? paired[0]!.model : `${paired.length} iPhones`} paired`)
  parts.push(`load ${report.load.oneMinute.toFixed(1)} / ${report.load.cores} cores`)
  return parts.join(' · ')
}
