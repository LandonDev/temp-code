import type { MacBridgeRequest } from '@server/shared/contract-macbridge'
import { macBridgeStore } from '../lib/macBridge'

/** ui:preview: a host's list with a running command, a live computer session and one the computer cap holds. */
const req = (id: string, over: Partial<MacBridgeRequest>): MacBridgeRequest => ({
  id,
  environmentId: 'env_box',
  hostName: 'box',
  sessionId: id,
  threadTitle: 'iOS build',
  kind: 'run',
  method: 'mac.run',
  argv: ['xcodebuild', '-scheme', 'TempCode', 'test'],
  cwd: '/Users/me/app',
  createdAt: 1,
  expiresAt: 600_000,
  status: 'running',
  ...over
})

const computer = { kind: 'computer' as const, method: 'mac.computer' as const, argv: undefined, cwd: undefined }
macBridgeStore.setState({
  requests: Object.fromEntries(
    [
      req('r1', {}),
      req('s1', { ...computer, createdAt: 2, threadTitle: 'Lunch invite', computer: { app: 'TextEdit', window: 'Untitled', actions: [] } }),
      req('s2', {
        ...computer,
        createdAt: 3,
        threadTitle: 'Notes cleanup',
        computer: { app: 'Notes', window: null, actions: [] },
        status: 'held',
        held: { reason: 'computer', position: 1, load: 1.2, limit: 16, cores: 8, maxRunning: 4, running: 2, computer: 1, maxComputer: 1 }
      })
    ].map((r) => [r.id, r])
  )
})

export default [{ name: 'A command, a live session and one in line', props: { environmentId: 'env_box', hostName: 'box' } }]
