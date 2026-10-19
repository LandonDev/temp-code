import type { EventRow, SessionMeta } from './events'

/**
 * The shapes a remote connection sees that a local one does not. A
 * connection declares its profile once, at open (`?profile=remote` on the
 * socket URL); `local` is byte-for-byte what the renderer saw before the
 * profile existed. The budgets behind these shapes live in wireBudgets.ts.
 */

export type WireProfile = 'local' | 'remote'

/** A body the remote profile kept off the wire. It stands in the body's
 *  own slot (a tool result's `output`, a string inside a tool call's
 *  `input`, a preview's `lines`); `session.rowBody` fetches the row whole.
 *  The persisted row is untouched. */
export interface OmittedBody {
  omitted: true
  /** UTF-8 bytes of the body as persisted (the encoded bytes, for a preview's lines) */
  bytes: number
  /** newline-separated lines of the body */
  lines: number
  /** the body's first line, cut to BODY_HEAD_CHARS: its one-line summary */
  head: string
}

export function isOmittedBody(value: unknown): value is OmittedBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { omitted?: unknown }).omitted === true &&
    typeof (value as { bytes?: unknown }).bytes === 'number'
  )
}

/** `session.events` on a remote connection: one bounded page of the log.
 *  Rows may hold OmittedBody values where a body was large. */
export interface EventsPage {
  rows: EventRow[]
  /** persisted rows older than `rows[0]` remain in the asked range: page
   *  them with `beforeSeq: rows[0].seq` and `tail` */
  moreBefore: boolean
  /** rows newer than the last one remain in the asked range (a forward
   *  walk hit its page budget): continue with `afterSeq: <last seq>` */
  moreAfter: boolean
  /** the gap after `afterSeq` was larger than the resume budget: `rows`
   *  is a fresh tail of the log, so drop what you hold and fold these */
  reset: boolean
}

/** `session.list` on a remote connection: one page of metas, working
 *  threads first. `cursor` continues the walk; null on the last page. */
export interface SessionPage {
  sessions: SessionMeta[]
  cursor: string | null
}
