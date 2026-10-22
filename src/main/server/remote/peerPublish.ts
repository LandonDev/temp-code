import { PUBLISH_OFFER, type PublishRun, type PublishStartArgs } from '@shared/contract-publish'
import { PeerCalls, PeerOfflineError } from './peerCalls'

export interface PeerPublishDeps {
  environmentId: string
  calls: PeerCalls
  macPeerOf: (sessionId: string) => string | null
}

/** The box half: one publish call carries the Mac job's output and final status. */
export class PeerPublish {
  constructor(private readonly deps: PeerPublishDeps) {}

  resolveMac(sessionId: string): string {
    const bridged = this.deps.macPeerOf(sessionId)
    if (bridged && this.deps.calls.online(bridged, PUBLISH_OFFER)) return bridged
    const registered = this.deps.calls.registeredIds(PUBLISH_OFFER)
    if (registered.length === 1) return registered[0]
    if (!registered.length) throw new Error('no Mac paired')
    throw new Error(
      `several Macs are linked (${registered.join(', ')}): pick one for this thread with macBridge.thread.set (the thread menu, "Mac bridge")`
    )
  }

  start(
    sessionId: string,
    args: PublishStartArgs,
    onLine: (line: string) => void
  ): { done: Promise<PublishRun>; stop: () => Promise<void> } {
    const envId = this.resolveMac(sessionId)
    const caller = { environmentId: this.deps.environmentId, sessionId }
    const callId = PeerCalls.newCallId()
    let partial = ''
    const done = this.deps.calls
      .call<PublishRun>(envId, 'publish.start', { caller, args }, 90 * 60_000, {
        callId,
        onProgress: ({ chunk }) => {
          const lines = (partial + chunk).split('\n')
          partial = lines.pop() ?? ''
          for (const line of lines) onLine(line.replace(/\r$/, ''))
        }
      })
      .catch((err: unknown) => {
        if (err instanceof PeerOfflineError)
          throw new Error('the Mac went offline during the publish')
        throw err
      })
      .finally(() => {
        if (partial) onLine(partial.replace(/\r$/, ''))
      })
    return {
      done,
      stop: async () => {
        try {
          await this.deps.calls.call(envId, 'publish.stop', { caller, args: {} }, 30_000)
        } finally {
          this.deps.calls.cancel(callId, 'stopped')
        }
      }
    }
  }
}
