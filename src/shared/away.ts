import { z } from 'zod'

// Away from computer (src/main/server/away.ts): the person's own state, one
// copy per host, mirrored both ways over the peer links (remote/awaySync.ts),
// newest wins. While it is on, threads decide without asking.

export const AwayStateSchema = z.object({
  enabled: z.boolean(),
  /** When it last flipped (epoch ms); 0 for a host that never flipped. */
  at: z.number(),
  /** The environment id of the host where it flipped. */
  by: z.string()
})
export type AwayState = z.infer<typeof AwayStateSchema>

/** This host's tally of the stretch: how many decisions each thread made while away. */
export const AwayDecidedSchema = z.object({
  since: z.number(),
  threads: z.array(z.object({ sessionId: z.string(), count: z.number().int().min(0) }))
})
export type AwayDecided = z.infer<typeof AwayDecidedSchema>

export const AWAY_OFF_STATE: AwayState = { enabled: false, at: 0, by: '' }

/** A state from elsewhere wins only when it is newer; equal times keep what is here. */
export const isNewerAway = (incoming: AwayState, current: AwayState): boolean => incoming.at > current.at

/** How many decisions a tally holds. */
export const decidedTotal = (decided: AwayDecided): number =>
  decided.threads.reduce((sum, t) => sum + t.count, 0)
