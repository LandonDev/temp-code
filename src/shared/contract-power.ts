import { z } from 'zod'

// Keep awake (src/main/server/keepAwake.ts, docs/box.md "Keep awake"): the
// Mac holds its display awake while a thread here or on a linked host is
// live. Settings → Hosts reads and sets it on This Mac's row.

export const KeepAwakeModeSchema = z.enum(['while-working', 'never'])

/** → KeepAwakeStatus (keepAwake.ts). */
export interface KeepAwakeStatusWire {
  mode: z.infer<typeof KeepAwakeModeSchema>
  supported: boolean
  holding: boolean
  onBattery: boolean
}

const request = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ id: z.string(), method: z.literal(method), params })

export const PowerRequestSchemas = [
  /** → KeepAwakeStatus. */
  request('power.status', z.object({}).optional()),
  /** → KeepAwakeStatus. */
  request('power.settings.set', z.object({ keepAwake: KeepAwakeModeSchema }))
] as const
