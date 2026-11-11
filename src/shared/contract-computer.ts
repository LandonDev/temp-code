import { z } from 'zod'
import { PermissionsSchema, TierSchema } from './computer/protocol'
import { SCHEDULE } from './computer/scheduleRules'
import { ComputerToolResultSchema, TierVerdictSchema } from './computer/tools'

/**
 * Computer use over the app's own wire (docs/computer-protocol.md "The
 * host"): the state of this host's `tc-computer` service, one row per thread
 * whose computer session is live, Stop on that row, and the codex and Muse
 * bridge's four `computer_*` tools. The service itself speaks its own wire
 * (computer/protocol.ts); nothing here reaches it.
 */

const request = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ id: z.string(), method: z.literal(method), params })

/** Crashes in two minutes that put the service down for five (computer/service.ts). */
export const COMPUTER_CRASHES_TO_DOWN = 5

/** This host's service: never started, starting, up, shut down after idling, down after crashes, or unavailable here. */
export const ComputerServiceStateSchema = z.object({
  state: z.enum(['off', 'starting', 'up', 'idle', 'down', 'unavailable']),
  /** down or unavailable: the one line why */
  reason: z.string().optional(),
  pid: z.number().int().optional(),
  epoch: z.string().optional(),
  /** down: when it may spawn again, epoch ms */
  until: z.number().int().optional(),
  restarts: z.number().int().nonnegative(),
  permissions: PermissionsSchema.nullable()
})
export type ComputerServiceState = z.infer<typeof ComputerServiceStateSchema>

/** One thread whose computer session is live: from its first computer call in a turn until the turn settles. */
export const ComputerSessionRowSchema = z.object({
  threadId: z.string(),
  since: z.number().int(),
  lastCallAt: z.number().int(),
  /** the apps in the order last used, each with the window this thread last used there */
  apps: z.array(z.object({ name: z.string(), bundleId: z.string().nullable(), window: z.string().nullable() })),
  running: z
    .object({
      tool: z.string(),
      words: z.string(),
      startedAt: z.number().int(),
      /** `words` is a hold's line (the scheduler's, the bridge's guard standing), not an action */
      held: z.literal(true).optional()
    })
    .nullable(),
  /** the tier the last step that sent input ran at */
  tier: TierSchema.nullable(),
  // A box thread's row mirrored from its Mac (contract-maccomputer.ts); the bridge alone sets these.
  /** the Mac's environment id */
  macPeer: z.string().optional(),
  /** what this host calls the Mac */
  macName: z.string().optional(),
  /** a card waits on the Mac: its title as a question (approvalLine's form) */
  asking: z.object({ line: z.string() }).optional()
})
export type ComputerSessionRow = z.infer<typeof ComputerSessionRowSchema>

export interface ComputerSessionsAnswer {
  service: ComputerServiceState
  sessions: ComputerSessionRow[]
}

/** One app's learned verdict, as Settings → Computer use shows it. */
export const ComputerAppVerdictSchema = z.object({
  bundleId: z.string().min(1),
  /** null for a verdict saved before names were kept */
  name: z.string().nullable(),
  classes: TierVerdictSchema.shape.classes,
  updatedAt: z.number().int()
})
export type ComputerAppVerdict = z.infer<typeof ComputerAppVerdictSchema>

/** This Mac's computer settings: the session tier's idle threshold and every app it learned. */
export const ComputerSettingsSchema = z.object({
  sessionIdleMs: z.number().int(),
  apps: z.array(ComputerAppVerdictSchema)
})
export type ComputerSettings = z.infer<typeof ComputerSettingsSchema>

/** `computer.settings.set`: a partial, each field written alone. */
export const ComputerSettingsPatchSchema = z.object({
  sessionIdleMs: z.number().int().min(SCHEDULE.sessionIdleMsMin).max(SCHEDULE.sessionIdleMsMax).optional()
})
export type ComputerSettingsPatch = z.infer<typeof ComputerSettingsPatchSchema>

/** What `app.computer` answers the bridge: the result text, its pictures (or none), and whether nothing ran. */
export const AppComputerAnswerSchema = ComputerToolResultSchema.extend({ isError: z.boolean() })
export type AppComputerAnswer = z.infer<typeof AppComputerAnswerSchema>

export interface AppComputerToolsAnswer {
  tools: { name: string; description: string; inputSchema: Record<string, unknown> }[]
}

/** The edge a preview asks for, in frame pixels: the box's width × devicePixelRatio, rounded up to 64. */
export const PREVIEW_MIN_EDGE = 256
export const PREVIEW_MAX_EDGE = 960

/** The bridge's own MCP request id: what `app.computerCancel` names. */
const BridgeCallSchema = z.union([z.string(), z.number()])

export const ComputerRequestSchemas = [
  /** → ComputerSessionsAnswer */
  request('computer.sessions', z.object({})),
  /** → { stopped: boolean }: Stop on the Activity row; computer use ends for the thread's turn */
  request('computer.stop', z.object({ sessionId: z.string() })),
  // The codex and Muse bridge (scripts/app-mcp-bridge.mjs): `token` is the
  // thread's own, so one thread's bridge never acts as another.
  /** → AppComputerAnswer */
  request(
    'app.computer',
    z.object({
      sessionId: z.string(),
      token: z.string(),
      call: BridgeCallSchema,
      tool: z.string(),
      args: z.record(z.string(), z.unknown()),
      images: z.enum(['parts', 'none'])
    })
  ),
  /** → null: the harness gave the call up; a waiting card is denied, an action cancelled */
  request('app.computerCancel', z.object({ sessionId: z.string(), token: z.string(), call: BridgeCallSchema })),
  /** → AppComputerToolsAnswer: the four tools as the bridge lists them */
  request('app.computerTools', z.object({ sessionId: z.string(), token: z.string() })),
  // The live preview (computer/preview.ts): the desktop's own socket only, since frames are the
  // person's windows. `threadId` is the key the host's sessions know: a Mac thread's id, or a box
  // thread's `macComputerKey(envId, threadId)`.
  /** → ComputerPreviewStart */
  request('computer.preview.start', z.object({ threadId: z.string(), maxEdge: z.number().int().min(PREVIEW_MIN_EDGE).max(PREVIEW_MAX_EDGE) })),
  /** → null: the frame `seq` was drawn; the next one may come */
  request('computer.preview.ack', z.object({ preview: z.string(), seq: z.number().int().nonnegative() })),
  /** → null */
  request('computer.preview.stop', z.object({ preview: z.string() })),
  // Settings → Computer use (surfaces/settings/Computer.tsx): this Mac's desktop only.
  /** → ComputerSettings */
  request('computer.settings.get', z.object({})),
  /** → ComputerSettings */
  request('computer.settings.set', ComputerSettingsPatchSchema),
  /** → ComputerSettings: one app's verdict gone, or every app's with null; the next call probes again */
  request('computer.verdicts.forget', z.object({ bundleId: z.string().min(1).nullable() })),
  /** → Permissions | null: the service's own while it is up, else one `tc-computer permissions`; null when computer use is unavailable here or the read failed */
  request('computer.permissions', z.object({})),
  /** → ComputerServiceState: Try again on a service down after crashes */
  request('computer.service.retry', z.object({})),
  /** → null: a session hold for no thread, so a proof can show the banner without the session tier; refused unless TEMP_CODE_E2E_STATUS=1 */
  request('computer.proofHold', z.object({ on: z.boolean() }))
] as const


export interface ComputerPreviewStart {
  /** the relay's own id for this watcher: it outlives the service stream across retargets */
  preview: string
  app: string
  window: string | null
  width: number
  height: number
  /** the stream ended while this start waited (a minimized window, Screen Recording off): no frames come until it starts again */
  ended?: ComputerPreviewEndReason
}

/** To every client, once per burst (at most four a second). */
export interface ComputerPush {
  push: 'computer'
  service: ComputerServiceState
  sessions: ComputerSessionRow[]
}

/** To every client when the threshold or a verdict changes, at most once a second. */
export interface ComputerSettingsPush {
  push: 'computer-settings'
  settings: ComputerSettings
}

/** One frame of a preview, to the socket that asked only. At most one in flight per watcher until its ack. */
export interface ComputerFramePush {
  push: 'computer-frame'
  preview: string
  seq: number
  width: number
  height: number
  /** base64 JPEG */
  data: string
}

/** The agent clicked in the previewed window: `at` is in the pixels of a `width` × `height` frame, which need not be the last one drawn. */
export interface ComputerClickPush {
  push: 'computer-click'
  preview: string
  /** [x, y] */
  at: number[]
  width: number
  height: number
}

export const PREVIEW_END_REASONS = ['closed', 'window-closed', 'minimized', 'permission', 'restarted', 'error'] as const
export type ComputerPreviewEndReason = (typeof PREVIEW_END_REASONS)[number]

/** The preview moved to another window (`live`), or ended and why. */
export interface ComputerPreviewPush {
  push: 'computer-preview'
  preview: string
  state: 'live' | 'ended'
  reason?: ComputerPreviewEndReason
  app?: string
  window?: string | null
  width?: number
  height?: number
}
