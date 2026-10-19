import type { ClientRequest } from '@shared/contract'
import { CONTRACT_VERSION } from '@shared/capabilities'
import type { RemoteStatus } from '@shared/contract-remote'

/** What the `remote.*` RPCs reach. The listener and auth store arrive in
 *  later slices; until then status reports the identity and an off listener. */
export interface RemoteContext {
  environmentId: string
}

type Handled = { handled: true; result: unknown } | { handled: false }
const result = (value: unknown): Handled => ({ handled: true, result: value })

export async function handleRemote(req: ClientRequest, ctx: RemoteContext): Promise<Handled> {
  switch (req.method) {
    case 'remote.status':
      return result({
        environmentId: ctx.environmentId,
        enabled: false,
        port: 0,
        running: false,
        error: null,
        origin: '',
        publicOrigin: '',
        learnedOrigin: null,
        contract: CONTRACT_VERSION
      } satisfies RemoteStatus)
    default:
      return { handled: false }
  }
}
