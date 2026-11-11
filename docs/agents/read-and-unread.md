# Read and unread: the host's mark

- A thread's host owns its read mark: `sessions.read_at`, on the wire as
  `SessionMeta.readAt`, the thread's `updatedAt` as of the last time the
  person saw it on any client (0: unseen since it began, or marked unread).
  A thread is unread while `updatedAt > readAt`, the rule the desktop and
  the phone already ran on their own maps; the rules that are not about
  sync stay (only settled roots, nothing inside a master, `housedIds`; the
  thread on screen never). The mark is not an edit: it never moves
  `updatedAt` (src/main/server/db.ts `markSessionRead`, never back, never
  past the row). The column's add stamps every existing thread read, so
  the upgrade lights nothing; a thread made since starts unread.
- RPCs `session.markRead { items: [{ sessionId, at? }] }` (one call
  carries a client's coalesced marks; `at` absent = as the row stands) and
  `session.markUnread { sessionIds }`, both `operate` (a read key watches
  without moving them), relayed (`RELAY_METHODS`: a Mac thread read on the
  phone is marked on the Mac), in the phone's subset; the meta push carries
  the mark to every client, and the launch mirror keeps it with the rest of
  the meta. An older host sends no `readAt` and its clients keep their own
  maps.
- The desktop (src/renderer/src/lib/readMarks.ts, installed by
  stores/subscriptions.ts `installReadMarks`): the hosts' marks lie over the
  window's own seen map (lib/sessionSeen.ts `installHostMarks`), except the
  thread on screen, which stays the window's; the thread the person looks
  at (`FocusSignal.attended`: the focused pane, the window focused, the
  person present) is marked as its `updatedAt` moves, and every Mark all
  read path (`markSessionsSeen`, `markAllSeen`) sends too. Writes are per
  host, one request 1.5 s after the last mark and never more than 5 s after
  the first, held while the host's link is down and sent when it opens; a
  write not yet heard back covers its thread meanwhile. The phone
  (ios/TempCodeClient `Client/ReadMarks.swift` and `EnvironmentClient`'s
  `seen`): the same overlay and coalescing, written by `markSeen` while the
  app is in the foreground with an operate key. Tests:
  src/main/server/db-read.test.ts, lib/readMarks.test.ts,
  lib/sessionSeen.test.ts, the phone's ReadMarksTests and the two cases in
  EnvironmentClientTests.
