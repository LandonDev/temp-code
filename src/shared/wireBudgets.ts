/**
 * Byte and row budgets of the remote wire profile (`?profile=remote` on the
 * socket URL), pinned by src/main/server/wire.perf.test.ts
 * (`bun run test:perf:wire`). A local connection keeps today's shapes and
 * limits. Each number carries the reason it is what it is; change the two
 * together and let the test say what moved.
 *
 * Borrowed from T3 Code's wire invariants (docs/internals/performance-
 * regressions.md): a cold open of about a megabyte that is a target rather
 * than a cap, bodies off the wire with the stored log intact, a resume that
 * replays a small gap and snapshots a large one, and an active-only shell
 * with archived rows behind their own request.
 */

export const KIB = 1024
export const MIB = 1024 * KIB

/** A body (a tool's output, a string in a tool's input, a preview's diff
 *  lines) of this many UTF-8 bytes or more leaves the wire on a remote
 *  connection; `session.rowBody` fetches the row whole. Measured 2026-10-19
 *  over the newest 300k rows of the prod snapshot: rows at 2 KiB or more are
 *  1.8% of rows and 60% of bytes (tool results 34 of 38 MB, tool inputs 8 of
 *  17 MB); a 4 KiB line keeps nine points more of the bytes for 0.7 points
 *  fewer rows. Assistant text and thinking stay whole: 11% and 0% of their
 *  bytes sit above the line, and they are the conversation. */
export const BODY_OMIT_BYTES = 2 * KIB

/** The first characters of an omitted body that ride along as its summary:
 *  a shell output's first line, the start of a file. One short line. */
export const BODY_HEAD_CHARS = 160

/** A cold open (`session.events` with `tail`) stops adding older rows once
 *  the encoded rows pass this. T3 Code's cold-open target and about two
 *  seconds on a poor cellular link before deflate. The newest row always
 *  ships, so one huge row can pass it: a target, not a cap. */
export const TAIL_BYTES = 1 * MIB

/** Rows a cold open asks for at most (the renderer's own TAIL_ROWS); the
 *  byte target cuts it shorter. Rows, never turns: an agent thread packs
 *  38k rows into two turns. */
export const TAIL_ROWS = 300

/** A resume (`session.events` with only `afterSeq`) replays at most this
 *  many rows and this many encoded bytes; a larger gap comes back as a
 *  fresh tail with `reset`. 128 is T3 Code's replay cap: a gap that size
 *  costs less than a snapshot, and past it the client would fold what the
 *  snapshot gives it anyway. */
export const RESUME_ROWS = 128
export const RESUME_BYTES = 1 * MIB

/** An older-history page (`beforeSeq` with `tail`) or a forward walk
 *  (`afterSeq` with `limit`) stops at this many encoded bytes and rows.
 *  Half a cold open: a page lands while the reader scrolls, it never
 *  competes with the live rows for the link. */
export const HISTORY_PAGE_BYTES = 512 * KIB
export const HISTORY_PAGE_ROWS = 300

/** `session.list` for remote returns pages of at most this many encoded
 *  bytes and rows; the first page is the shell a remote client paints
 *  from. A session meta is 0.6 to 1 KB, so 256 KiB is about 300 rows:
 *  every working thread plus the newest idle ones, in one round trip. */
export const SHELL_PAGE_BYTES = 256 * KIB
export const SHELL_PAGE_ROWS = 300

/** Pushes to a remote connection wait this long and go out as one frame
 *  per kind: a streaming turn emits dozens of rows a second, and a fleet
 *  of a hundred subagents hundreds of metas; at 100 ms the reader sees no
 *  lag and the link sees ten frames a second at most per kind. */
export const PUSH_COALESCE_MS = 100

/** permessage-deflate on remote connections skips frames under this many
 *  bytes: the deflate header and a flush cost more than they save on a
 *  one-line frame, and most status and queue frames are that small. */
export const DEFLATE_THRESHOLD = 1 * KIB
