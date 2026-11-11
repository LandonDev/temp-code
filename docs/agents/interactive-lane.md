# The interactive lane: the thread on screen goes first

- `session.focus { sessionId | null }` (operate): each socket names the
  thread its window's focused pane shows (`FocusSignal` in
  lib/tcserver/commands.ts, sent from SessionPane's focused-pane effect,
  null while the window is blurred or its person is away: locked, asleep or
  no input for 2 minutes, src/main/attention.ts over `app:attention`; again
  after a reconnect). The host's
  `FocusSet` (src/main/server/focus.ts) keeps the union across sockets,
  widened to subagents and a focused master's batch; a closed socket drops
  its own. `RunningServer.isInteractive` and the scheduler's `focused` hook
  read it. Beside it the socket names `shown` (the same pane's thread while
  the document is visible, whatever the window's focus or attention), which
  makes that thread's rows leave the push coalescer at once
  (`FocusSet.pushesAtOnce`); nothing else reads it.
- Requests sort into lanes (src/main/server/lane.ts): interactive (names an
  interactive thread, or the renderer marked it `lane: 'ui'`: send,
  approve, answer, stop, pause, resume, start now, archive, the fleet
  switches), bulk (project.changes, project.compare, git.diffStats,
  git.diffIndex, an unfocused checkpoint.status, search.project,
  session.search, commands.list, github.*, resources.*, doctor.get,
  fs.watch, the deploy, publish and sync methods), normal (the rest). Two
  of them answer from a host cache, since the panels ask on every mount,
  focus and branch change: `github.prStatus` for 60 s per checkout and
  branch (concurrent asks share one gh child; the host's own PR and
  comment mutations forget the checkout, `invalidatePrStatus`),
  `project.compare` for 30 s per checkout, target and HEAD
  (`COMPARE_TTL_MS`), and `git.diffIndex` / `git.branches` for 3 s per
  checkout while the git dir's HEAD, index, reflog and refs have not moved
  (gitops.ts `gitDiffIndexCached`, `gitCacheTtl`; the host's own readers
  call the plain functions). No helper child forks from the main process:
  every git, gh, ps, ss and lsof runs from the exec broker's utility
  process (src/main/server/execBroker.ts, spawnBudget.ts; docs/box.md
  "The exec broker"), and the guard reads /proc on Linux (procScan.ts). attach() answers through
  `serve(req, sendFrame)`; the `LaneGate` runs bulk two at a time while the
  loop's mean lag is under 50 ms, joins a duplicate read (method and a
  digest of params, from any socket) to the one waiting or running, runs a
  write or fs.watch each in its turn (dropped if its socket closed first),
  and runs anything that waited 20 s, up to twice the bulk cap at once. The
  path fence runs before the gate.
- Pushes: a socket's own focused thread's rows go at once; other threads'
  rows wait 33 ms, or 100 ms locally and 250 ms remotely while the loop
  lags (wire.ts `eventsWindowMs`). A socket whose send queue passes the
  backpressure mark sheds the unfocused session and event pushes (the
  replayable ones; control and peer frames stay) and tells the client to
  `resync` once it drained to half; one past 64 MiB is closed (1013,
  `SocketBudget` in wire.ts). Stall lines end
  `lane=bulk:<running>/<held>`; the renderer reports `first-paint
  session=<id> host=<env> ms=<n>` past 500 ms (lib/firstPaint.ts).
- The host's own jobs pause on `yieldUntilIdle` (cold mover, turn index
  backfill, fold sweep, mirror backfill, archive and attachment sweeps) or
  run through `whenLoopIdle` (liveness sweep, headroom.json save, accounts
  rebuild); the scheduler pass waits for a quiet loop and comes at most
  every 250 ms while the loop lags.
  Server close stops that registry's thread mirror timers and awaits its writes before closing the reader and database (`mirror.ts`, `stopMirrors`).
  `SessionRegistry.close()` marks the registry closed first, clears pending titles and timers, and keeps late title, fold, driver and report callbacks from using the store; `disposeAll()` puts down the harnesses and leaves the registry usable.
- Proof: `bun run script:e2e-interactive-lane` (200 git.diffStats against a
  scratch repo beside a focused socket reading a 2,000-row thread; on the
  Mac: focused p95 3 ms, 15 git children where 200 runs would spawn 600).
