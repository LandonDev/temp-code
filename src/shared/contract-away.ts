import { z } from 'zod'
import { AwayStateSchema, type AwayDecided, type AwayState } from './away'

// Away from computer (src/shared/away.ts, src/main/server/away.ts): the
// switch, its tally, and the peer leg remote/awaySync.ts speaks.

const request = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ id: z.string(), method: z.literal(method), params })

export const AwayRequestSchemas = [
  /** → { state, decided } */
  z.object({ id: z.string(), method: z.literal('away.get'), params: z.object({}).optional() }),
  /** → { state }: the person's flip, stamped here. */
  request('away.set', z.object({ enabled: z.boolean() })),
  /** → { state, applied }: a peer's state, taken only when newer. */
  request('away.apply', z.object({ state: AwayStateSchema }))
] as const

export interface AwaySnapshot {
  state: AwayState
  decided: AwayDecided
}

/** To every client socket on each change of the state or the tally. */
export type AwayPush = { push: 'away' } & AwaySnapshot
