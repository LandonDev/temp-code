import type { MacBridgeRequest } from '@server/shared/contract-macbridge'
import { macBridgeStore } from '../lib/macBridge'

/** ui:preview: a box thread's computer card waiting on this Mac. */
const card: MacBridgeRequest = {
  id: 'c1',
  environmentId: 'env_box',
  hostName: 'box',
  sessionId: 's1',
  threadTitle: 'Lunch invite',
  kind: 'computer',
  method: 'mac.computer',
  computer: { app: 'TextEdit', window: 'Untitled', actions: ['click button "Save"', 'type "Lunch on Friday?"'] },
  createdAt: 1,
  expiresAt: 600_000,
  status: 'pending'
}
macBridgeStore.setState({ requests: { c1: card } })

export default [{ name: 'A computer card', props: { environmentId: 'env_box', sessionId: 's1' } }]
