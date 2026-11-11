import { z } from 'zod'
import { PermissionsSchema, TierSchema } from './computer/protocol'
import { ACTIVE_APP_MODES, SCHEDULE } from './computer/scheduleRules'
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

/** This Mac's computer settings: the session tier's idle threshold, when a step that needs the app in front gets it (§26.6), and every app it learned. */
export const ComputerSettingsSchema = z.object({
  sessionIdleMs: z.number().int(),
  activeApp: z.enum(ACTIVE_APP_MODES),
  apps: z.array(ComputerAppVerdictSchema)
})
export type ComputerSettings = z.infer<typeof ComputerSettingsSchema>

/** `computer.settings.set`: a partial, each field written alone. */
export const ComputerSettingsPatchSchema = z.object({
  sessionIdleMs: z.number().int().min(SCHEDULE.sessionIdleMsMin).max(SCHEDULE.sessionIdleMsMax).optional(),
  activeApp: z.enum(ACTIVE_APP_MODES).optional()
})
export type ComputerSettingsPatch = z.infer<typeof ComputerSettingsPatchSchema>

// ── the thread's computer history (computer/history.ts): what the Computer section lists ──

/** What a step is, for its glyph: a pointer act, text put in, a key, a scroll, a read, a picture the model asked for, a wait, an app call. */
export const COMPUTER_STEP_KINDS = ['click', 'type', 'key', 'scroll', 'read', 'look', 'wait', 'app'] as const
export type ComputerStepKind = (typeof COMPUTER_STEP_KINDS)[number]

/** How a step ended. A planned step (its call still runs, or never finished) has none. */
export const COMPUTER_STEP_STATES = ['ok', 'failed', 'not-run', 'stopped'] as const
export type ComputerStepState = (typeof COMPUTER_STEP_STATES)[number]

/**
 * One step of a call, in words the host made once (shared/computer/historyWords.ts):
 * present tense while planned, past once settled. No typed text a password
 * field could hold ever enters a step.
 */
export const ComputerHistoryStepSchema = z.object({
  kind: z.enum(COMPUTER_STEP_KINDS),
  /** drawn muted: "Clicked" */
  verb: z.string(),
  /** what the verb acts on, the app left out: "Save", "into Subject"; empty when the app is all there is */
  object: z.string(),
  /** the same with the app, as the transcript's row reads: "Save in TextEdit", "TextEdit" */
  inApp: z.string(),
  state: z.enum(COMPUTER_STEP_STATES).optional(),
  /** the tier the step ran at; the reader words it (COMPUTER_TIER_WORDS) */
  tier: TierSchema.optional(),
  /** what it acted on, more exactly than the words: `a button in the "Save As" sheet`, `at 500, 300` */
  target: z.string().optional(),
  /** how it went, each a fact of one comma run */
  facts: z.array(z.string()).optional(),
  /** a failed, stopped or refused step: why, in a person's words */
  reason: z.string().optional(),
  /** the element it acted on, by its index in the read's text */
  element: z.number().int().positive().optional()
})
export type ComputerHistoryStep = z.infer<typeof ComputerHistoryStepSchema>

/** Why a call has no picture. `gone` is said by a read alone: the picture was kept once and is past the newest 400. */
export const HISTORY_PICTURE_NONE = ['permission', 'minimized', 'not-drawn', 'off', 'no-read', 'failed', 'gone'] as const
export type HistoryPictureNone = (typeof HISTORY_PICTURE_NONE)[number]

export const ComputerHistoryPictureSchema = z.union([
  z.object({ width: z.number().int().positive(), height: z.number().int().positive(), at: z.number().int() }),
  z.object({ none: z.enum(HISTORY_PICTURE_NONE) })
])
export type ComputerHistoryPicture = z.infer<typeof ComputerHistoryPictureSchema>

/** One computer call of a thread, folded from its journal records. */
export const ComputerHistoryCallSchema = z.object({
  /** counts up per thread */
  n: z.number().int().positive(),
  /** the turn it ran in, counting up per thread */
  turn: z.number().int().positive(),
  /** when it passed its checks, epoch ms */
  at: z.number().int(),
  endedAt: z.number().int().optional(),
  /** `running` in this process, `done` once it answered, `unfinished` for a start whose end never came */
  state: z.enum(['running', 'done', 'unfinished']),
  /** the app and the window it used; empty and null for a call that named neither */
  app: z.string(),
  window: z.string().nullable(),
  steps: z.array(ComputerHistoryStepSchema),
  /** a batch's planned steps in the card's words, while it runs */
  plan: z.array(z.string()).optional(),
  /** what the model took in: "Read 46 elements" */
  read: z.string().optional(),
  /** the read's text is kept and says more than its header: `computer.history.step` returns it */
  text: z.boolean(),
  /** absent until the picture's record lands */
  picture: ComputerHistoryPictureSchema.optional(),
  /** the call's record count: a reader keeps the higher one */
  rev: z.number().int().positive()
})
export type ComputerHistoryCall = z.infer<typeof ComputerHistoryCallSchema>

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
