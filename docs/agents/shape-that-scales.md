# The shape that scales: many threads exist, a bounded number run

docs/box.md "The shape that scales" has the before numbers, each step's
proof and the sizing rules; the pieces, by name:
- `doctor.profile` (admin): an in-process CPU profile of the main process
  into `<userData>/logs/profiles/`; Help → "Profile the Host for 10 Seconds" on
  the Mac, `tc-local doctor.profile` on the box; read it with
  scripts/profile-summary.ts, the stall log with scripts/stalls-summary.ts.
  `currentLag()` and `untilLoopIdle()` in stalls.ts are what the lane and
  the host's own jobs read.
- `session.focus` and the lanes: "The interactive lane" above.
- Checkpoints are the host's (src/main/server/checkpointTurns.ts): every
  send refreshes the baseline (`CheckpointStore.ensure`: one `git diff`
  listing per send, none per path; a path that became dirty between turns
  is the person's, snapshotted, never claimed by the settle's sync, never
  undone, and shown only once a write tool edits it, when Undo restores
  their bytes), a
  settled live edit costs a set lookup (a baseline path's is a no-op), a write tool's complete call (Edit,
  MultiEdit, Write, NotebookEdit) touches the path its input names the same
  way (`writtenPath`; the Edit tool writes through a temporary name and
  renames it onto the target, so the checkpoint never depends on what the
  watcher saw), the mid-turn flush writes only paths on disk and the settle
  forgets a path neither HEAD nor the disk has (made and removed inside the
  turn, or the tool's temporary file whose edit settled after the turn),
  a turn's settle writes the manifest and syncs once and pushes
  `checkpoint-changed`; status, undo and keep take a sessionId only. The strip above the composer
  (chrome/SessionReview.tsx) is their only control, and its Undo confirms.
- A thread's pane tells `loading`, `slow` and `failed` from empty (the
  store's `load` phase, request deadlines and retries in
  lib/connection/transport.ts and link.ts); empty is the host's word
  (`load.empty`: loaded with no persisted row), never a page that folded to
  nothing, and a fetch in flight is joined only by the owner it was made
  for (docs/TRANSCRIPT.md "A fetch belongs to its owner"). A tab restored
  at boot is the store's thread, never a layout stub's: `loadSession`
  answers the store's session when the active pane's first load fails
  (the host's socket not open yet) and the pane retries, and
  `sessionStore.mutate` gives a stub (born of `newSession`, no `status`)
  for a thread the host has named the meta's fields, so a restored master
  keeps `isMaster` and opens on its board (store.test.ts "a layout stub
  for a thread the host has listed", sessionStore.test.ts "loadSession
  when the host is not connected yet"). `ensureMeta` asks the owning host
  first (the entry's, a mirror row's, or a named host), then only
  connected hosts, once each with retry off; past a 300 ms window a tab
  opens a provisional entry the meta fills whole or that reads `gone`, and
  a pane whose thread is gone shows "No longer on <host>" with Close tab
  and Open archived (`SessionGone`); the new-chat screen is a project's one
  remembered draft (lib/projectDrafts.ts, keyed like the strip order, never
  a chip, opened by every New thread path through App's `openProjectDraft`;
  its draft row's "Name this thread" field (chrome/DraftTitleField.tsx, 80
  characters, kept on the record as `title`) is the thread's title from the
  first send, `session.create { title }`: a title that is no placeholder
  (src/shared/placeholderTitles.ts) is never sliced from the message nor
  replaced by the generated one, and an empty field leaves both as before;
  the phone's New thread sheet has the same row;
  coming back to a project, a workspace or the home takes one rule,
  `landingOf` in lib/projectLanding.ts: the newest root that runs or needs
  you (a batch thread's master on its board), else the newest unread (the
  rail's rule), else the newest unarchived root at rest, else the draft
  only once nothing unarchived is left; never an archived thread, and no
  remembered thread or open tab outranks it),
  and the host archives empty placeholder threads a day old at boot
  (`archiveEmptyThreads`); the board under Search, Inbox, Notes,
  Accounts or Settings is parked (`.board-parked`), never display:none.
  A provisional entry resolves on its host's word, never as a draft
  (`resolveProvisional`: the archived sets, owner first; `gone` only once
  the owner listed and answered; `settleDrafts` skips it), and a saved tab
  whose thread existed (`persisted` on its layout stub, or a titled stub
  saved before the stamp, `isPersistedStub`) that no host answered for at
  launch restores as one (`restoreProvisional` in lib/sessionStore.ts)
  carrying its title and place. The host refuses `session.events` for an
  id it shows no row for (`unknown session: <id>`, wire.ts
  `sessionEvents`), which the store reads as `gone` with the meta out of
  the lists. The new-chat screen (`EmptySession`) is a draft's alone; a
  thread its host holds with no rows shows the composer under one muted
  line (`NoRowsLine`: the failure summary, else "No messages yet"). An
  `adopt` loads like any open unless this window created the thread empty
  (`{ created: true }`: a draft's first send, an appshot chat). Delete
  keeps the window on its project (lib/threadDelete.ts `planThreadDelete`,
  decided from the layout before the delete, since `session-removed`
  lands ahead of the answer): the neighbour chip takes the thread on
  screen's place (`deleteNeighbour`, Archive's rule without the outside
  chip), else another tab of the project, else the project's empty
  screen; a split loses only the pane.
- `batch.board { masterId }` (read): the master board's one answer;
  "Master threads" above.
- The gateway's byte path runs in a utility process ("Provider traffic"
  above); the route scope carries the model, so no body is parsed.
- Stats off the loop: `aliax:stats:get` ran the Stats bundle (a dozen
  synchronous `node:sqlite` aggregates over 30 to 120 days, queries.ts) on
  the main loop, 3.2 to 3.5 s every other open once its 60 s cache missed,
  and the first open ran the index (indexer.ts: `statSync` per file, a
  per-line parse, prepared inserts) beside it. Both run in the stats worker
  now (`src/main/aliax/stats/statsWorker.ts`, a fourth main entry beside
  `gateway` in electron.vite.config.ts, a worker thread `statsService.ts`
  starts over `<userData>/stats.db`): `statsEngine.ts` is the index and the
  bundle over one connection (the bundle cached in the worker until it
  writes anything: an index pass, a usage sample, an app event),
  `statsHost.ts` is main's side (one bundle ask in flight shared by every
  caller, the progress mirrored, the samples and app events forwarded, one
  restart, then `unavailable`: the last bundle it gave, else an empty one,
  with the reason on `StatsBundle.unavailable`, which the Stats page says as
  one red line under its title; Reindex starts a worker left down again); the pages' three handlers
  and aliax.ts's usage sample and app event hooks go through the host, and
  main never opens stats.db. Proof `bun run script:e2e-stats-loop` (the
  box's real logs indexed twice, on the loop and through the worker, the
  loop's worst lag under each).
- `admission.get` / `admission.set`: the running cap; "Master threads"
  above.
- A project switch: `bun run script:measure-project-switch`
  (scripts/measure-project-switch.ts, on the Mac: a TEMP_CODE_PROFILE=1
  build under a fresh userData, paired read-only to the box and revoked at
  exit, the named threads with the right panel on Changes or closed, a
  scratch workspace with N untracked files) prints click → paint, long
  tasks, React commit time, the Changes rows mounted and requests per
  click; docs/box.md "Measuring a project switch" has the table.
