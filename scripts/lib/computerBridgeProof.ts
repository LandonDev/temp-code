import { guiLaunchEnvironment } from './tcProbeApp'
import { COMPUTER_BRIDGE_NOTE } from '../../src/shared/computer/tools'

/** The remote note belongs on computer_apps alone, including the held-result list. */
export function bridgeHasOneRemoteNote(tools: readonly { name: string; description: string }[]): boolean {
  const noted = tools.filter((t) => t.description.endsWith(COMPUTER_BRIDGE_NOTE))
  return noted.length === 1 && noted[0].name === 'computer_apps'
}

export { guiLaunchEnvironment as bridgeProbeEnvironment }

/** Read the button from a full observation; a delta may omit an unchanged Ping. */
export function bridgeProbePing(text: string): number {
  const index = text.match(/\[(\d+)\] button "Ping"/)?.[1]
  if (index === undefined) throw new Error('the full TC Probe observation has no Ping button; refusing to send an invalid click')
  return Number(index)
}

/** Never turn a failed held call into a second, invalid computer_result call. */
export function bridgeHeldId(text: string): string {
  const id = text.match(/^Held after[^\n]*computer_result with id "(c\d+)"/)?.[1]
  if (!id) throw new Error(`the click did not answer held with an id: ${text.slice(0, 300)}`)
  return id
}

/** The cancellation notice must not hide a failure of the read that follows it. */
export function bridgeCancelledProbeRead(text: string, isError: boolean | undefined): boolean {
  return !isError && /^Cancelled c\d+ \(left_click \[\d+\] in TC Probe\) before it ran\./.test(text)
}

/** Wait through a real Mac load/cap hold without ending the proof's synthetic turn. */
export async function waitForBridgeProofCall<T>(
  answer: Promise<T>,
  opts: { standing: () => Promise<string | null>; log: (line: string) => void; timeoutMs?: number }
): Promise<T> {
  let last: string | null = null
  let reading = false
  let closed = false
  let deadline: ReturnType<typeof setTimeout>
  const poll = setInterval(() => {
    if (reading) return
    reading = true
    void opts.standing().then((standing) => {
      if (!closed && standing && standing !== last) opts.log(`waiting for the Mac: ${standing}`)
      if (!closed) last = standing
    }).catch(() => undefined).finally(() => { reading = false })
  }, 1_000)
  const timeoutMs = opts.timeoutMs ?? 120_000
  const expired = new Promise<never>((_, reject) => {
    deadline = setTimeout(() => reject(new Error(`the Mac computer call did not finish within ${timeoutMs / 1000} s${last ? `: ${last}` : ''}`)), timeoutMs)
  })
  try {
    return await Promise.race([answer, expired])
  } finally {
    closed = true
    clearInterval(poll)
    clearTimeout(deadline!)
  }
}
