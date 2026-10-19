import { z } from 'zod'

// Remote access (plan 5jtfkIC45Cbr): the `remote.*` RPCs the desktop
// settings pane uses. All admin; the loopback socket is implicitly admin.

export interface RemoteStatus {
  environmentId: string
  /** The remote listener's state; `port` is 0 while it is off. */
  enabled: boolean
  port: number
  running: boolean
  /** Why the listener is not running, when it should be. */
  error: string | null
  /** The pairing link base: configured, else learned from the proxy, else loopback. */
  origin: string
  publicOrigin: string
  learnedOrigin: string | null
  contract: number
}

const request = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ id: z.string(), method: z.literal(method), params })

export const RemoteRequestSchemas = [request('remote.status', z.object({}).optional())] as const
