import { z } from 'zod'
import { PermissionsSchema, TierSchema } from './computer/protocol'
import { ComputerToolResultSchema } from './computer/tools'

/**
 * Computer use over the app's own wire (docs/computer-protocol.md "The
 * host"): the state of this host's `tc-computer` service, one row per thread
 * whose computer session is live, Stop on that row, and the codex and Muse
 * bridge's four `computer_*` tools. The service itself speaks its own wire
 * (computer/protocol.ts); nothing here reaches it.
 */

const request = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ id: z.string(), method: z.literal(method), params })

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
  running: z.object({ tool: z.string(), words: z.string(), startedAt: z.number().int() }).nullable(),
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

/** What `app.computer` answers the bridge: the result text, its pictures (or none), and whether nothing ran. */
export const AppComputerAnswerSchema = ComputerToolResultSchema.extend({ isError: z.boolean() })
export type AppComputerAnswer = z.infer<typeof AppComputerAnswerSchema>

export interface AppComputerToolsAnswer {
  tools: { name: string; description: string; inputSchema: Record<string, unknown> }[]
}

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
  request('app.computerTools', z.object({ sessionId: z.string(), token: z.string() }))
] as const

/** To every client, once per burst (at most four a second). */
export interface ComputerPush {
  push: 'computer'
  service: ComputerServiceState
  sessions: ComputerSessionRow[]
}
