import type { BatchState } from './contract-batch'

type Blocked = NonNullable<BatchState['blocked']>

/** What blocks a batch's end, in words: "Blocked: Inbox ended its turn
 *  without completing". The board's foot and the host's watching-master
 *  line both say it; the phone's `MasterBoard.blockedLine` is the same. */
export function blockedWords(blocked: Blocked, who: string | null | undefined, host?: string | null): string {
  const name = who?.trim() || 'a thread'
  return `Blocked: ${name} ${blockedReason(blocked.why, host)}`
}

function blockedReason(why: Blocked['why'], host: string | null | undefined): string {
  switch (why) {
    case 'no-turn':
      return 'ended its turn without completing'
    case 'unreachable':
      return `is out of reach on ${host?.trim() || 'another host'}`
    default:
      return why
  }
}
