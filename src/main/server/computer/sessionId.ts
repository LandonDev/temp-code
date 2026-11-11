import { createHash } from 'node:crypto'

/** The thread id when the capture plan's session pattern takes it, else `t_` and 40 hex of its sha256. Also the name of a thread's directory under the history root, so no key ever escapes it. */
export function serviceSessionId(threadId: string): string {
  return /^[A-Za-z0-9_-]{1,64}$/.test(threadId) ? threadId : `t_${createHash('sha256').update(threadId).digest('hex').slice(0, 40)}`
}
